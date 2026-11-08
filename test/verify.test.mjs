import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const V = require('../verify.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/* Mirrors server/fair.mjs: the top seed is random, every earlier seed is the SHA-256 of
   the next one, and the terminal is the SHA-256 of the first seed. */
function buildChain(length) {
  const buf = Buffer.alloc(length * 32);
  crypto.randomBytes(32).copy(buf, (length - 1) * 32);
  for (let i = length - 1; i > 0; i--) {
    crypto.createHash('sha256')
      .update(buf.subarray(i * 32, (i + 1) * 32))
      .digest()
      .copy(buf, (i - 1) * 32);
  }
  const terminal = crypto.createHash('sha256').update(buf.subarray(0, 32)).digest('hex');
  const seed = (index) => buf.subarray(index * 32, (index + 1) * 32).toString('hex');
  const hash = (index) => crypto.createHash('sha256').update(Buffer.from(seed(index), 'hex')).digest('hex');
  return { seed, hash, terminal };
}

function referenceResult(saltHex, seedHex) {
  const digest = crypto.createHmac('sha256', Buffer.from(saltHex, 'hex'))
    .update(Buffer.from(seedHex, 'hex'))
    .digest('hex');
  const r = Number.parseInt(digest.slice(0, 13), 16);
  const x = 99 / (1 - r / Math.pow(2, 52));
  return Math.max(1, Math.floor(x) / 100);
}

const SALT = crypto.randomBytes(32).toString('hex');
const FIRST_ROUND = 1000;

function chainEntry(chain) {
  return {
    id: 7,
    terminalHash: chain.terminal,
    salt: SALT,
    saltHeight: 870123,
    length: 400,
    firstRound: FIRST_ROUND
  };
}

test('sha256 matches node for short and long inputs', () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from('abc'),
    Buffer.from('the quick brown fox jumps over the lazy dog'),
    crypto.randomBytes(1),
    crypto.randomBytes(32),
    crypto.randomBytes(64),
    crypto.randomBytes(1000)
  ];
  for (const sample of samples) {
    const expected = crypto.createHash('sha256').update(sample).digest('hex');
    assert.equal(V.toHex(V.sha256(new Uint8Array(sample))), expected, 'input of ' + sample.length + ' bytes');
  }
});

test('hmac-sha256 matches node and the RFC 4231 vector', () => {
  const key = Buffer.alloc(20, 0x0b);
  const message = Buffer.from('Hi There');
  assert.equal(
    V.toHex(V.hmacSha256(new Uint8Array(key), new Uint8Array(message))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  );
  for (let i = 0; i < 20; i++) {
    const k = crypto.randomBytes(32);
    const m = crypto.randomBytes(32);
    const expected = crypto.createHmac('sha256', k).update(m).digest('hex');
    assert.equal(V.toHex(V.hmacSha256(new Uint8Array(k), new Uint8Array(m))), expected);
  }
});

test('gameResult agrees with an independent implementation', () => {
  const chain = buildChain(32);
  for (let i = 0; i < 32; i++) {
    const seed = chain.seed(i);
    assert.equal(V.gameResult(Buffer.from(SALT, 'hex'), Buffer.from(seed, 'hex')), referenceResult(SALT, seed));
  }
});

test('a round with its seed replays and anchors to the chain', () => {
  const chain = buildChain(400);
  const index = 137;
  const round = FIRST_ROUND + index;
  const report = V.verifyRound({
    hash: chain.hash(index),
    round,
    seed: chain.seed(index),
    rows: 10,
    chain: 7,
    chains: [chainEntry(chain)]
  });

  assert.equal(report.fatal, undefined);
  assert.equal(report.ok, true);
  assert.equal(report.round, round);
  assert.equal(report.index, index);
  assert.equal(report.rows.length, 10);
  assert.equal(report.rows[0].round, round);
  assert.equal(report.rows[0].hash, chain.hash(index));
  assert.equal(report.rows[9].round, round - 9);
  assert.equal(report.rows[9].hash, chain.hash(index - 9));
  for (let i = 0; i < report.rows.length; i++) {
    assert.equal(report.rows[i].result, referenceResult(SALT, chain.seed(index - i)));
  }
  assert.ok(report.checks.every((check) => check.ok));
});

test('without a seed the table starts at the previous round', () => {
  const chain = buildChain(400);
  const index = 137;
  const round = FIRST_ROUND + index;
  const report = V.verifyRound({
    hash: chain.hash(index),
    round,
    rows: 10,
    chains: [chainEntry(chain)]
  });

  assert.equal(report.ok, true);
  assert.equal(report.rows.length, 10);
  assert.equal(report.rows[0].round, round - 1);
  assert.equal(report.rows[0].hash, chain.hash(index - 1));
  assert.ok(report.notes.some((note) => note.includes('seed')));
});

test('a wrong round number is reported and corrected', () => {
  const chain = buildChain(400);
  const index = 137;
  const round = FIRST_ROUND + index;
  const report = V.verifyRound({
    hash: chain.hash(index),
    round: round + 5,
    seed: chain.seed(index),
    rows: 10,
    chain: 7,
    chains: [chainEntry(chain)]
  });

  assert.equal(report.ok, false);
  assert.equal(report.round, round);
  assert.ok(report.checks.some((check) => !check.ok && check.text.includes('round #' + round)));
});

test('a result that does not replay fails the check', () => {
  const chain = buildChain(400);
  const index = 137;
  const report = V.verifyRound({
    hash: chain.hash(index),
    round: FIRST_ROUND + index,
    seed: chain.seed(index),
    result: 99.99,
    rows: 6,
    chains: [chainEntry(chain)]
  });

  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => !check.ok && check.text.startsWith('The result shown does not replay')));
});

test('a matching result passes the check', () => {
  const chain = buildChain(400);
  const index = 137;
  const seed = chain.seed(index);
  const expected = referenceResult(SALT, seed);
  const report = V.verifyRound({
    hash: chain.hash(index),
    round: FIRST_ROUND + index,
    seed,
    result: expected,
    rows: 3,
    chains: [chainEntry(chain)]
  });

  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.ok && check.text.startsWith('The result shown for this round replays')));
});

test('the first round of a chain needs its seed', () => {
  const chain = buildChain(400);
  const report = V.verifyRound({
    hash: chain.hash(0),
    round: FIRST_ROUND,
    rows: 10,
    chains: [chainEntry(chain)]
  });

  assert.match(report.fatal, /first round/);

  const withSeed = V.verifyRound({
    hash: chain.hash(0),
    round: FIRST_ROUND,
    seed: chain.seed(0),
    rows: 3,
    chains: [chainEntry(chain)]
  });
  assert.equal(withSeed.ok, true);
  assert.equal(withSeed.rows[0].round, FIRST_ROUND);
  assert.equal(withSeed.rows[0].hash, chain.terminal);
});

test('an unknown hash is refused instead of guessed', () => {
  const chain = buildChain(400);
  const report = V.verifyRound({
    hash: crypto.randomBytes(32).toString('hex'),
    round: 10500,
    rows: 10,
    chains: [chainEntry(chain)]
  });

  assert.match(report.fatal, /does not reach any published chain/);
});

test('a chain anchor in the past keeps working after a rollover', () => {
  const old = buildChain(400);
  const fresh = buildChain(400);
  const entries = [
    { id: 6, terminalHash: old.terminal, salt: crypto.randomBytes(32).toString('hex'), length: 400, firstRound: 100 },
    { id: 7, terminalHash: fresh.terminal, salt: SALT, length: 400, firstRound: 1000 }
  ];
  const report = V.verifyRound({
    hash: old.hash(250),
    round: 350,
    seed: old.seed(250),
    rows: 4,
    chains: entries
  });

  assert.equal(report.ok, true);
  assert.equal(report.chain.id, 6);
});

test('the page is a static document with no network path', () => {
  const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(repo, 'app.js'), 'utf8');
  const worker = fs.readFileSync(path.join(repo, 'worker.js'), 'utf8');

  assert.match(html, /default-src 'none'/);
  assert.match(html, /worker-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/);
  assert.doesNotMatch(app, /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage/);
  assert.doesNotMatch(worker, /\bfetch\s*\(|XMLHttpRequest/);
});

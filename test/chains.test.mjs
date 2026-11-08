import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../tools/check-public.mjs', import.meta.url));
const shipped = fileURLToPath(new URL('../chains.js', import.meta.url));

function run(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [tool, file], (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function fixture(body) {
  const dir = await mkdtemp(join(tmpdir(), 'chains-'));
  const file = join(dir, 'chains.js');
  await writeFile(file, body, 'utf8');
  return { file, done: () => rm(dir, { recursive: true, force: true }) };
}

const anchor = 'a'.repeat(64);
const salt = 'b'.repeat(64);

test('a commitment file with only published fields is accepted', async () => {
  const f = await fixture('self.CT_CHAINS = [{ "id": 7, "terminalHash": "' + anchor + '", "salt": "' + salt +
    '", "saltHeight": 870123, "length": 30000, "committedAt": "2026-11-07T09:00:00.000Z", "firstRound": 10501 }];\n');
  try {
    const out = await run(f.file);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /1 public chain commitment/);
  } finally { await f.done(); }
});

test('an empty list is accepted, so the site can ship before the first export', async () => {
  const out = await run(shipped);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /publishable/);
});

test('a seed field is refused even when every other field is valid', async () => {
  const f = await fixture('self.CT_CHAINS = [{ "id": 7, "terminalHash": "' + anchor + '", "salt": "' + salt +
    '", "saltHeight": 1, "length": 30000, "committedAt": "x", "firstRound": 1, "seed": "' + salt + '" }];\n');
  try {
    const out = await run(f.file);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /not published: seed/);
  } finally { await f.done(); }
});

test('a truncated anchor is refused', async () => {
  const f = await fixture('self.CT_CHAINS = [{ "id": 7, "terminalHash": "abc", "salt": "' + salt +
    '", "saltHeight": 1, "length": 30000, "committedAt": "x", "firstRound": 1 }];\n');
  try {
    const out = await run(f.file);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /terminalHash is not a 64-character hex hash/);
  } finally { await f.done(); }
});

test('a file that never assigns CT_CHAINS is refused', async () => {
  const f = await fixture('/* nothing here */\n');
  try {
    const out = await run(f.file);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /does not assign self\.CT_CHAINS/);
  } finally { await f.done(); }
});

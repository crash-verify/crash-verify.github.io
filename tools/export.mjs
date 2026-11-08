#!/usr/bin/env node
/* Refreshes chains.js from the game's public endpoints.

   It reads nothing but /api/fair/chain, /api/history and /api/fair/round/:id, all of
   which are unauthenticated and already public. It never asks for a seed, never opens the
   database, and never needs a credential. Entries are merged by chain id, so an older
   chain keeps its first round and stays verifiable after it leaves the live window.

   Usage:
     node tools/export.mjs --base https://game.example
     node tools/export.mjs --base http://127.0.0.1:8080 --limit 20 --out chains.js
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function fail(message, code = 1) {
  console.error('export: ' + message);
  process.exit(code);
}

const base = String(arg('base', process.env.CRASHTOP_BASE || '')).trim().replace(/\/+$/, '');
if (!base) fail('pass the public game origin, for example --base https://game.example', 2);

let origin;
try {
  origin = new URL(base);
} catch {
  fail('--base is not a valid URL', 2);
}
if (origin.username || origin.password) fail('--base must not embed credentials', 2);
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(origin.hostname);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) {
  fail('--base must use https (http is allowed only for loopback)', 2);
}

const limit = Math.min(Math.max(Number(arg('limit', '20')) || 20, 1), 100);
const outPath = path.resolve(repo, arg('out', 'chains.js'));

const HEX64 = /^[0-9a-f]{64}$/;

async function get(pathname) {
  const url = new URL(pathname, origin);
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(pathname + ' -> HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error(pathname + ' did not answer with JSON');
  return res.json();
}

function hex64(value) {
  const clean = String(value == null ? '' : value).trim().toLowerCase();
  return HEX64.test(clean) ? clean : '';
}

function iso(value) {
  if (value == null || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readExisting(file) {
  if (!fs.existsSync(file)) return [];
  const body = fs.readFileSync(file, 'utf8');
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const rows = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(rows) ? rows.filter((row) => row && Number.isSafeInteger(Number(row.id))) : [];
  } catch {
    return [];
  }
}

function render(entries) {
  return [
    '/* Generated file. Run `node tools/export.mjs --base https://<game-host>` to refresh it.',
    '   It holds public chain commitments only: an anchor hash, the chain\'s Bitcoin block salt',
    '   and the round range. No seed, no per-round record, nothing that reveals a future round. */',
    'self.CT_CHAINS = ' + JSON.stringify(entries, null, 2) + ';',
    ''
  ].join('\n');
}

const report = await get('/api/fair/chain').catch((err) => fail(err.message));
const commitments = Array.isArray(report.commitments) ? report.commitments.slice(0, limit) : [];

/* The newest round tells us where its chain started: round id minus the chain index. */
const firstRound = new Map();
try {
  const history = await get('/api/history?limit=1');
  const newest = history && Array.isArray(history.history) ? history.history[0] : null;
  if (newest && Number.isSafeInteger(Number(newest.id))) {
    const round = await get('/api/fair/round/' + Number(newest.id));
    if (round && round.chainId != null && Number.isSafeInteger(Number(round.chainIndex))) {
      firstRound.set(Number(round.chainId), Number(newest.id) - Number(round.chainIndex));
    }
  }
} catch (err) {
  console.warn('export: first-round lookup skipped: ' + err.message);
}

const merged = new Map();
for (const row of readExisting(outPath)) merged.set(Number(row.id), row);

let written = 0;
let skipped = 0;
for (const chain of commitments) {
  const id = Number(chain && chain.id);
  if (!Number.isSafeInteger(id) || id < 1) { skipped += 1; continue; }
  const terminalHash = hex64(chain.terminal_hash);
  const salt = hex64(chain.salt);
  if (!terminalHash || !salt) { skipped += 1; continue; }
  const previous = merged.get(id) || {};
  merged.set(id, {
    id,
    terminalHash,
    salt,
    saltHeight: Number.isSafeInteger(Number(chain.salt_height)) ? Number(chain.salt_height) : null,
    length: Number.isSafeInteger(Number(chain.length)) ? Number(chain.length) : null,
    committedAt: iso(chain.committed_at) || previous.committedAt || null,
    firstRound: Number.isSafeInteger(Number(previous.firstRound))
      ? Number(previous.firstRound)
      : (firstRound.get(id) ?? null)
  });
  written += 1;
}

const entries = Array.from(merged.values()).sort((a, b) => a.id - b.id);
fs.writeFileSync(outPath, render(entries), 'utf8');

console.log(
  'export: ' + path.relative(repo, outPath) + ' — ' +
  entries.length + ' chain(s), ' + written + ' refreshed, ' + skipped + ' skipped'
);

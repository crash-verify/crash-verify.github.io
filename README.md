# CrashTop round verifier

A single static page that checks a CrashTop round hash against the published hash chain and
replays the results in the browser. No database, no login, no connection to the game server,
no third-party script.

Open the page with a round:

```
https://crash-verify.github.io/crashtop-verifier/#round=10523&chain=7&hash=<64 hex>&seed=<64 hex>&result=2.31
```

Everything after `#` stays in the browser. The page never sends it anywhere.

## What it checks

A round is committed with a hash published while betting is still open, and its result is
fixed by the server seed revealed after the bust. The chain is built downwards:

```
seed[j-1] = SHA-256(seed[j])            terminal = SHA-256(seed[0])
hash[j]   = SHA-256(seed[j]) = seed[j-1]
result[j] = max(1, floor(99 / (1 - X)) / 100)
X         = int(HMAC-SHA256(salt, seed[j])[0..52 bits], 16) / 2^52
```

Because each published hash is the seed of the round before it, hashing a published hash
backwards walks the chain. Hashing it exactly `index` times reaches the chain's terminal —
the anchor that was published before the chain's first round.

The page runs four checks:

1. **Commitment** — `SHA-256(seed) == hash` for the round.
2. **Replay** — the published result is exactly what the seed produces.
3. **Chain walk** — hashing backwards reaches the published chain anchor.
4. **Position** — the hash sits at the round number it claims.

Then it prints the round and the nine before it, each with its hash and replayed result.

## What it does not prove

A static page cannot prove that a whole file was not rebuilt after the fact. What it can prove
is that the rounds are links of one chain, that every result replays from its seed, and that
the chain reaches an anchor. The anchor is the trust root: compare it with the value the game
published before the chain started (the commitment log or the external commitment webhook).
Without that comparison the page is a consistency check, not a timestamp.

The salt is a Bitcoin block hash. The page links to a public explorer so you can confirm the
block yourself; it never queries an API.

## Inputs

| Field | Required | Meaning |
| --- | --- | --- |
| Round hash | yes | The hash shown for the round in the game. |
| Round number | yes | The round id. Used to label the rows and to check the chain position. |
| Rows | no | How many rounds to replay. Default 10, maximum 50. |
| Chain | no | Pick the chain, or let the page detect it by walking to an anchor. |
| Server seed | no | The seed revealed after the round. Adds the round's own result to the table. |
| Chain salt / anchor | no | Only for a chain that is not in `chains.js` yet. |

Without the seed the table starts at `round - 1`, because the published hash of round `n` is
the seed of round `n - 1`.

## `chains.js`

`chains.js` holds public chain commitments only:

```js
self.CT_CHAINS = [
  { "id": 7, "terminalHash": "...", "salt": "...", "saltHeight": 870123,
    "length": 30000, "committedAt": "2026-11-07T09:00:00.000Z", "firstRound": 10501 }
];
```

No seed, no per-round record, no user data. It is generated from the game's public endpoints:

```
node tools/export.mjs --base https://<game-host>
```

The script reads `/api/fair/chain`, `/api/history?limit=1` and `/api/fair/round/:id`, merges
by chain id (so old chains stay verifiable), and rewrites the file. It needs no credential and
opens no database. Run it whenever a chain rolls over, or on a weekly schedule.

## Publish

The site is `https://crash-verify.github.io/crashtop-verifier/`, served from
`github.com/crash-verify/crashtop-verifier` by `.github/workflows/pages.yml`.

1. Create the empty public repository `crashtop-verifier` under the `crash-verify` account and
   push these files to `main`.
2. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. Nothing else
   is configured there; the workflow does the rest, and does not need a token or secret.
3. Every push to `main` runs the tests, refuses a `chains.js` that carries anything beyond a public
   commitment, and publishes. **Actions → Deploy verifier to GitHub Pages** deploys by hand; a manual
   run from another branch only builds and never publishes.

The workflow publishes at the URL GitHub reports for that repository, so renaming it to
`crash-verify.github.io` would serve the page at `https://crash-verify.github.io/` instead with no
change to the file — every asset is referenced relatively.

Give the game that origin through its public config:

```
FAIR_VERIFIER_URL=https://crash-verify.github.io/crashtop-verifier
```

The game then opens the verifier from the round panel and from the proof window with the round
already filled in. Leave it empty to keep the in-game action visible but inert.

## Development

```
node --test
node tools/check-public.mjs
```

The suite cross-checks SHA-256 and HMAC-SHA256 against Node's crypto, builds a synthetic chain
the way the server does, replays rounds through `verifyRound` with and without a seed, and checks
that `chains.js` refuses seed-shaped fields. The workflow runs the same two commands before it
publishes.

## Files

| File | Role |
| --- | --- |
| `index.html` | The page. CSP locks it to same-origin scripts, no network. |
| `styles.css` | Presentation. |
| `verify.js` | SHA-256, HMAC-SHA256, crash-point math, chain replay. No dependencies. |
| `worker.js` | Runs the replay off the render thread and reports progress. |
| `app.js` | Form, shared link, rendering. Text nodes only. |
| `chains.js` | Generated public chain commitments. |
| `tools/export.mjs` | Refreshes `chains.js` from the game's public endpoints. |
| `tools/check-public.mjs` | Refuses a `chains.js` that carries a field beyond the public commitment. |
| `.github/workflows/pages.yml` | Tests, checks `chains.js`, and publishes the site to GitHub Pages. |
| `test/verify.test.mjs` | Correctness tests. |
| `test/chains.test.mjs` | Tests for the publish guard. |

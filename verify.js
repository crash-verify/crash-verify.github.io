/* CrashTop round verifier — dependency-free SHA-256 / HMAC-SHA256, crash-point math,
   and the hash-chain replay. This file is shared by the page and the worker, and it
   also exports itself as a CommonJS module so the test suite can exercise it. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CTVerify = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* A chain is at most a few million links. The walk stops well before that so the
     worker can never lock a phone for minutes on a bad input. */
  var MAX_WALK = 400000;

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var H0 = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  var W = new Uint32Array(64);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function block(H, bytes, off) {
    var i, t1, t2, a, b, c, d, e, f, g, h;
    for (i = 0; i < 16; i++) {
      W[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
             (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var w15 = W[i - 15], w2 = W[i - 2];
      var s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      var s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    a = H[0]; b = H[1]; c = H[2]; d = H[3];
    e = H[4]; f = H[5]; g = H[6]; h = H[7];
    for (i = 0; i < 64; i++) {
      t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  function sha256(bytes) {
    var len = bytes.length;
    var total = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    var bits = len * 8;
    var dv = new DataView(buf.buffer);
    dv.setUint32(total - 4, bits >>> 0, false);
    dv.setUint32(total - 8, Math.floor(bits / 4294967296) >>> 0, false);
    var H = new Uint32Array(H0);
    for (var off = 0; off < total; off += 64) block(H, buf, off);
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
    return out;
  }

  function hmacSha256(key, msg) {
    if (key.length > 64) key = sha256(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var k = key[i] || 0;
      ipad[i] = k ^ 0x36;
      opad[i] = k ^ 0x5c;
    }
    var inner = new Uint8Array(64 + msg.length);
    inner.set(ipad); inner.set(msg, 64);
    var ih = sha256(inner);
    var outer = new Uint8Array(64 + 32);
    outer.set(opad); outer.set(ih, 64);
    return sha256(outer);
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /* Trim, drop a 0x prefix, collapse whitespace and lower case. Anything that is not
     hex after that returns an empty string so the caller can reject it. */
  function normHex(value) {
    var s = String(value == null ? '' : value).trim().replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase();
    return /^[0-9a-f]*$/.test(s) ? s : '';
  }

  function isHex64(value) {
    return /^[0-9a-f]{64}$/.test(value);
  }

  /* Published bustabit formula. The HMAC key is the chain salt, the message is the
     round's server seed. */
  function gameResult(salt, seed) {
    var digest = toHex(hmacSha256(salt, seed));
    var r = parseInt(digest.slice(0, 13), 16);
    var x = r / Math.pow(2, 52);
    x = 99 / (1 - x);
    return Math.max(1, Math.floor(x) / 100);
  }

  function normalizeChain(entry) {
    if (!entry) return null;
    var terminal = normHex(entry.terminalHash);
    var salt = normHex(entry.salt);
    if (!isHex64(terminal) || !isHex64(salt)) return null;
    var id = Number(entry.id);
    var length = Number(entry.length);
    var firstRound = Number(entry.firstRound);
    var saltHeight = Number(entry.saltHeight);
    return {
      id: Number.isSafeInteger(id) ? id : null,
      terminalHash: terminal,
      salt: salt,
      saltHeight: Number.isSafeInteger(saltHeight) && saltHeight > 0 ? saltHeight : null,
      length: Number.isSafeInteger(length) && length > 0 ? length : null,
      firstRound: Number.isSafeInteger(firstRound) && firstRound > 0 ? firstRound : null,
      committedAt: typeof entry.committedAt === 'string' ? entry.committedAt : null
    };
  }

  /* Replays one round and the rows before it.

     The chain is built downwards: seed[j-1] = SHA-256(seed[j]), and the terminal is
     SHA-256(seed[0]). Round j publishes hash[j] = SHA-256(seed[j]) = seed[j-1], so
     hashing a published hash k times lands on the terminal when k is the round's
     index in its chain.

     job = { hash, round, seed?, chain?, chains[], salt?, terminal?, result?, rows? }
     Returns { fatal } or a full report. */
  function verifyRound(job, onProgress) {
    var progress = typeof onProgress === 'function' ? onProgress : function () {};
    job = job || {};

    var hashHex = normHex(job.hash);
    if (!isHex64(hashHex)) return { fatal: 'The round hash must be 64 hexadecimal characters.' };

    var seedHex = job.seed ? normHex(job.seed) : '';
    if (seedHex && !isHex64(seedHex)) return { fatal: 'The server seed must be 64 hexadecimal characters.' };

    var round = Number(job.round);
    if (!Number.isSafeInteger(round) || round < 1) return { fatal: 'The round number must be a positive whole number.' };

    var rowsWanted = Number(job.rows);
    if (!Number.isSafeInteger(rowsWanted)) rowsWanted = 10;
    rowsWanted = Math.min(Math.max(rowsWanted, 1), 50);

    var chains = [];
    (job.chains || []).forEach(function (entry) {
      var chain = normalizeChain(entry);
      if (chain) chains.push(chain);
    });

    var hint = null;
    if (job.chain != null && job.chain !== '') {
      for (var h = 0; h < chains.length; h++) {
        if (chains[h].id === Number(job.chain)) { hint = chains[h]; break; }
      }
    }

    var hashBytes = hexToBytes(hashHex);
    var seedBytes = seedHex ? hexToBytes(seedHex) : null;
    var checks = [];

    if (seedBytes) {
      var commitmentOk = toHex(sha256(seedBytes)) === hashHex;
      checks.push({
        ok: commitmentOk,
        text: commitmentOk
          ? 'Hashing the revealed seed reproduces the published round hash.'
          : 'The revealed seed does not hash to the published round hash.'
      });
    }

    /* Walks backwards: hash[k] = SHA-256(hash[k-1]). A terminal match proves the hash
       belongs to that chain and gives its position inside it. */
    var found = null;
    var steps = 0;
    for (var a = 0; a < chains.length; a++) {
      if (chains[a].terminalHash === hashHex) { found = chains[a]; steps = 0; break; }
    }

    var cur = hashBytes;
    var walked = 0;
    var limit = Math.min(round, MAX_WALK);
    while (!found && walked < limit) {
      walked += 1;
      cur = sha256(cur);
      var hex = toHex(cur);
      for (var c = 0; c < chains.length; c++) {
        if (chains[c].terminalHash === hex) { found = chains[c]; steps = walked; break; }
      }
      if (walked % 5000 === 0) progress(walked, limit);
    }

    /* A wrong round number stops the first pass short of the terminal. The selected
       chain still tells us how far the chain runs, so keep walking to it. */
    if (!found && hint && hint.length && walked < Math.min(hint.length, MAX_WALK)) {
      var extra = Math.min(hint.length, MAX_WALK);
      while (walked < extra) {
        walked += 1;
        cur = sha256(cur);
        var hx = toHex(cur);
        for (var d = 0; d < chains.length; d++) {
          if (chains[d].terminalHash === hx) { found = chains[d]; steps = walked; break; }
        }
        if (found) break;
        if (walked % 5000 === 0) progress(walked, extra);
      }
    }

    var chain = found || hint;

    if (!chain) {
      var manualSalt = normHex(job.salt || '');
      var manualTerminal = normHex(job.terminal || '');
      if (isHex64(manualSalt)) {
        chain = {
          id: null,
          salt: manualSalt,
          terminalHash: isHex64(manualTerminal) ? manualTerminal : '',
          saltHeight: null,
          length: null,
          firstRound: null,
          committedAt: null
        };
      }
    }

    if (!chain) {
      return {
        fatal: 'This hash does not reach any published chain. Check the round number, pick the chain, or paste the chain salt in the advanced fields.'
      };
    }

    var notes = [];
    if (chain.terminalHash) {
      checks.push({
        ok: !!found,
        text: found
          ? 'Hashing this round back reaches the chain anchor that was published before the chain started.'
          : 'Hashing this round back does not reach the selected chain anchor.'
      });
    } else {
      notes.push('No chain anchor was supplied, so the walk could not be checked against a published value.');
    }

    var index = found ? steps : null;
    if (found && chain.firstRound != null) {
      var expected = chain.firstRound + steps;
      if (expected !== round) {
        checks.push({
          ok: false,
          text: 'This hash belongs to round #' + expected + ', not #' + round + '.'
        });
        round = expected;
      }
    }
    if (index == null && chain.firstRound != null) {
      index = round - chain.firstRound;
      if (index < 0) index = null;
    }

    /* The first round of a chain publishes the terminal hash itself, so its own seed
       cannot be derived from the hash: the seed has to come from the game. */
    if (!seedBytes && index === 0) {
      return { fatal: 'This is the first round of its chain. Its hash is the chain anchor, so the revealed seed is required to replay it.' };
    }

    var saltBytes = hexToBytes(chain.salt);
    var computed = seedBytes ? gameResult(saltBytes, seedBytes) : null;

    if (seedBytes && job.result != null && job.result !== '') {
      var shown = Number(job.result);
      var sameResult = Number.isFinite(shown) && Math.abs(computed - shown) < 1e-9;
      checks.push({
        ok: sameResult,
        text: sameResult
          ? 'The result shown for this round replays from its seed.'
          : 'The result shown does not replay: the seed gives ' + computed.toFixed(2) + 'x.'
      });
    }

    var rows = [];
    var source = seedBytes || hashBytes;
    var label = seedBytes ? round : round - 1;
    /* Rows stop at the chain's first round. Rounds before it belong to the previous chain,
       so this chain's seeds say nothing about their hashes. */
    var floor = chain.firstRound != null ? chain.firstRound : 0;
    for (var r = 0; r < rowsWanted && label >= floor; r++) {
      rows.push({
        round: label,
        hash: toHex(sha256(source)),
        result: gameResult(saltBytes, source),
        chainIndex: chain.firstRound != null ? label - chain.firstRound : (index != null ? index - (seedBytes ? r : r + 1) : null)
      });
      source = sha256(source);
      label -= 1;
    }

    if (!seedBytes) {
      notes.push('The entered hash is the commitment for round #' + round + ', which is the seed of round #' + (round - 1) + '. Paste the revealed server seed to replay round #' + round + ' itself.');
    }
    if (rows.length < rowsWanted && chain.firstRound != null) {
      notes.push('Only ' + rows.length + (rows.length === 1 ? ' round' : ' rounds') + ' of this chain exist at or before #' + round + ', so the table is shorter than requested.');
    }

    var ok = checks.every(function (check) { return check.ok; });

    return {
      hash: hashHex,
      round: round,
      chain: chain,
      index: index,
      checks: checks,
      notes: notes,
      rows: rows,
      computed: computed,
      ok: ok
    };
  }

  return {
    MAX_WALK: MAX_WALK,
    sha256: sha256,
    hmacSha256: hmacSha256,
    toHex: toHex,
    hexToBytes: hexToBytes,
    normHex: normHex,
    isHex64: isHex64,
    gameResult: gameResult,
    verifyRound: verifyRound
  };
});

/* CrashTop verifier page — reads the form or the shared link, runs the chain replay in a
   worker, and renders the report with text nodes only. No network, no storage. */
(function () {
  'use strict';

  var V = window.CTVerify;
  var CHAINS = Array.isArray(window.CT_CHAINS) ? window.CT_CHAINS.slice() : [];
  var worker = null;
  var lastReport = null;
  var shared = null;

  function $(id) { return document.getElementById(id); }

  function text(node, value) {
    node.textContent = value == null ? '' : String(value);
  }

  function el(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  }

  function readParams() {
    var raw = (location.hash && location.hash.length > 1)
      ? location.hash.slice(1)
      : (location.search ? location.search.slice(1) : '');
    var out = {};
    raw.split('&').forEach(function (pair) {
      if (!pair) return;
      var at = pair.indexOf('=');
      var key = at < 0 ? pair : pair.slice(0, at);
      var value = at < 0 ? '' : pair.slice(at + 1);
      try {
        out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch (err) { /* a malformed pair is ignored rather than breaking the page */ }
    });
    return out;
  }

  function chainLabel(chain) {
    var parts = ['Chain #' + chain.id];
    if (chain.length) parts.push(Number(chain.length).toLocaleString('en-US') + ' rounds');
    if (chain.saltHeight) parts.push('block ' + Number(chain.saltHeight).toLocaleString('en-US'));
    return parts.join(' · ');
  }

  function fillChainSelect() {
    var select = $('chain');
    var sorted = CHAINS.slice().sort(function (a, b) { return Number(b.id) - Number(a.id); });
    sorted.forEach(function (chain) {
      if (!chain || chain.id == null) return;
      var option = document.createElement('option');
      option.value = String(chain.id);
      text(option, chainLabel(chain));
      select.appendChild(option);
    });
  }

  function setStatus(message, tone) {
    var node = $('status');
    text(node, message);
    node.className = 'status' + (tone ? ' is-' + tone : '');
  }

  function setBusy(busy) {
    $('run').disabled = busy;
    $('run').textContent = busy ? 'Verifying\u2026' : 'Verify';
  }

  function readForm() {
    return {
      hash: V.normHex($('hash').value),
      round: Number(String($('round').value).trim()),
      rows: Number(String($('rows').value).trim()) || 10,
      chain: $('chain').value ? Number($('chain').value) : null,
      seed: V.normHex($('seed').value),
      salt: V.normHex($('salt').value),
      terminal: V.normHex($('terminal').value),
      result: null
    };
  }

  function validate(job) {
    if (!V.isHex64(job.hash)) return 'Enter the 64-character round hash.';
    if (!Number.isSafeInteger(job.round) || job.round < 1) return 'Enter the round number shown in the game.';
    if (job.seed && !V.isHex64(job.seed)) return 'The server seed must be 64 hexadecimal characters.';
    if (job.rows < 1 || job.rows > 50) return 'Rows must be between 1 and 50.';
    return '';
  }

  function run() {
    var job = readForm();
    var problem = validate(job);
    if (problem) {
      setStatus(problem, 'bad');
      return;
    }

    if (worker) worker.terminate();

    setBusy(true);
    setStatus('Hashing the chain\u2026');
    hide('verdict');
    hide('details');
    hide('results');

    job.chains = CHAINS;
    job.result = shared && shared.hash === job.hash ? shared.result : null;

    worker = new Worker('worker.js?v=1');
    worker.onmessage = function (event) {
      var message = event.data || {};
      if (message.type === 'progress') {
        var total = Math.max(1, Number(message.total) || 1);
        setStatus('Hashing the chain\u2026 ' + Math.round((Number(message.done) / total) * 100) + '%');
        return;
      }
      if (message.type === 'result') {
        setBusy(false);
        setStatus('Done.');
        render(message.result || { fatal: 'The verifier returned no result.' });
        worker.terminate();
        worker = null;
      }
    };
    worker.onerror = function () {
      setBusy(false);
      setStatus('The verifier worker could not start. Reload the page.', 'bad');
      worker = null;
    };
    worker.postMessage(job);
  }

  function hide(id) { $(id).hidden = true; }

  function render(report) {
    if (!report || report.fatal) {
      showVerdict(false, 'Not verified', (report && report.fatal) || 'Nothing to check.');
      return;
    }

    lastReport = report;
    showVerdict(
      report.ok,
      report.ok ? 'Verified' : 'Not verified',
      report.ok
        ? 'This hash walks back to the published chain anchor, and every row below replays from the chain.'
        : 'At least one check failed. Read the checks below before trusting this round.'
    );

    renderFacts(report);
    renderChecks(report.checks || []);
    renderNotes(report.notes || []);
    renderRows(report.rows || []);

    $('details').hidden = false;
    $('results').hidden = (report.rows || []).length === 0;
  }

  function showVerdict(ok, title, message) {
    var box = $('verdict');
    box.className = 'card verdict ' + (ok ? 'is-ok' : 'is-bad');
    box.replaceChildren(el('h2', null, title), el('p', null, message));
    box.hidden = false;
  }

  function fact(list, label, value, asNode) {
    list.appendChild(el('dt', null, label));
    var dd = document.createElement('dd');
    if (asNode) dd.appendChild(asNode);
    else dd.textContent = String(value == null ? '\u2014' : value);
    list.appendChild(dd);
  }

  function renderFacts(report) {
    var list = $('facts');
    list.replaceChildren();
    var chain = report.chain || {};

    fact(list, 'Chain', chain.id != null ? '#' + chain.id : 'manual entry');
    fact(list, 'Round', '#' + report.round);
    if (report.index != null) fact(list, 'Chain index', report.index + (chain.length ? ' of ' + Number(chain.length).toLocaleString('en-US') : ''));
    if (report.computed != null) fact(list, 'Replayed result', report.computed.toFixed(2) + 'x');

    if (chain.salt) {
      if (chain.saltHeight) {
        var link = document.createElement('a');
        link.href = 'https://www.blockchain.com/explorer/blocks/btc/' + encodeURIComponent(chain.saltHeight);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'block ' + Number(chain.saltHeight).toLocaleString('en-US') + ' \u2197';
        var wrap = document.createElement('span');
        wrap.appendChild(document.createTextNode(chain.salt + ' '));
        wrap.appendChild(link);
        fact(list, 'Chain salt', null, wrap);
      } else {
        fact(list, 'Chain salt', chain.salt);
      }
    }
    if (chain.terminalHash) fact(list, 'Chain anchor', chain.terminalHash);
    if (chain.committedAt) fact(list, 'Committed', chain.committedAt);
  }

  function renderChecks(checks) {
    var list = $('checks');
    list.replaceChildren();
    checks.forEach(function (check) {
      list.appendChild(el('li', check.ok ? 'ok' : 'bad', check.text));
    });
  }

  function renderNotes(notes) {
    var list = $('notes');
    list.replaceChildren();
    notes.forEach(function (note) { list.appendChild(el('li', null, note)); });
  }

  function renderRows(rows) {
    var body = $('rowBody');
    body.replaceChildren();
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'round', '#' + row.round));
      tr.appendChild(el('td', 'hash', row.hash));
      var result = el('td', 'num', row.result.toFixed(2) + 'x');
      result.className = 'num ' + (row.result >= 2 ? 'hot' : 'win');
      tr.appendChild(result);
      tr.appendChild(el('td', 'num', row.chainIndex == null ? '\u2014' : row.chainIndex));
      body.appendChild(tr);
    });
    text($('rowCount'), rows.length + (rows.length === 1 ? ' round' : ' rounds'));
  }

  function reset() {
    $('form').reset();
    $('rows').value = '10';
    hide('verdict');
    hide('details');
    hide('results');
    setStatus('');
    lastReport = null;
    shared = null;
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  }

  function prefill() {
    var params = readParams();
    if (params.hash) $('hash').value = params.hash.trim();
    if (params.round) $('round').value = String(params.round).trim();
    if (params.rows) $('rows').value = String(params.rows).trim();
    if (params.seed) $('seed').value = params.seed.trim();
    if (params.salt) $('salt').value = params.salt.trim();
    if (params.terminal) $('terminal').value = params.terminal.trim();
    if (params.chain) {
      var select = $('chain');
      var wanted = String(params.chain).trim();
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === wanted) { select.value = wanted; break; }
      }
    }
    if (params.result) {
      var result = Number(params.result);
      if (Number.isFinite(result)) shared = { hash: V.normHex(params.hash || ''), result: result };
    }
    return params;
  }

  function start() {
    fillChainSelect();
    var params = prefill();
    $('form').addEventListener('submit', function (event) {
      event.preventDefault();
      run();
    });
    $('reset').addEventListener('click', reset);
    if (params.hash && params.round) run();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

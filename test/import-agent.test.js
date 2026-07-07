'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const txmod = require('../server/transactions');

// --- unit: Markdown + format detection (still used by legacy importCSV path) --
test('parseMarkdown reads a GitHub pipe table, ignoring the separator row', () => {
  const md = [
    '# June statement',
    '',
    '| Date       | Description | Amount |',
    '|------------|-------------|--------|',
    '| 2026-06-01 | Kroger      | -45.67 |',
    '| 2026-06-03 | Paycheck    | 2000.00 |',
    '',
    'thanks for banking with us',
  ].join('\n');
  const rows = txmod.parseMarkdown(md);
  assert.deepEqual(rows[0], ['Date', 'Description', 'Amount']);
  assert.equal(rows.length, 3); // header + 2 data rows, separator dropped
  assert.deepEqual(rows[2], ['2026-06-03', 'Paycheck', '2000.00']);
});

test('detectFormat distinguishes Markdown tables from CSV', () => {
  assert.equal(txmod.detectFormat('| a | b |\n|---|---|\n| 1 | 2 |'), 'md');
  assert.equal(txmod.detectFormat('Date,Description,Amount\n2026-06-01,Kroger,-45.67'), 'csv');
});

// --- integration: the mandatory AI analysis gate --------------------------
// A stub analyst stands in for DeepSeek so tests are deterministic & offline.
// Unlike the old column-matching gate, the AI is handed the RAW file and is
// solely responsible for extracting the transaction list — there is no local
// header/column requirement in this path.
let server, base, extraction, seenPayload;

function stubAnalyzer() {
  return async (payload) => { seenPayload = payload; return extraction(payload); };
}

before(async () => {
  server = createApp({ dbPath: ':memory:', analyzeImport: stubAnalyzer() });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function makeAccount() {
  const r = await api('POST', '/api/accounts', { name: 'Checking', type: 'checking' });
  return r.json.account.id;
}

test('import is refused (nothing written) when the AI analyst finds no transactions', async () => {
  const accountId = await makeAccount();
  extraction = () => ({ transactions: [], notes: 'this file has no transaction-like content' });
  const r = await api('POST', '/api/transactions/import', {
    account_id: accountId,
    content: 'just some prose with no financial data at all',
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /no transactions/i);
  const list = await api('GET', `/api/transactions?account_id=${accountId}`);
  assert.equal(list.json.total, 0, 'nothing should be written when the AI finds nothing');
});

test('import is refused when the AI analyst is unreachable/unconfigured', async () => {
  const noAiServer = createApp({ dbPath: ':memory:' }); // no analyzeImport, no DEEPSEEK_API_KEY in test env
  await new Promise(res => noAiServer.listen(0, '127.0.0.1', res));
  const noAiBase = `http://127.0.0.1:${noAiServer.address().port}`;
  const acct = await (await fetch(`${noAiBase}/api/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Checking', type: 'checking' }),
  }).then(r => r.json())).account.id;
  const res = await fetch(`${noAiBase}/api/transactions/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: acct, content: 'Date,Description,Amount\n2026-06-01,Kroger,-45.67' }),
  });
  assert.equal(res.status, 503);
  noAiServer.close();
});

test('import writes transactions the AI extracts directly from the raw file, no column schema required', async () => {
  const accountId = await makeAccount();
  extraction = () => ({
    transactions: [
      { date: '2026-06-01', payee: 'Kroger', amount_cents: -4567, memo: '' },
      { date: '2026-06-03', payee: 'Paycheck', amount_cents: 200000, memo: '' },
    ],
    notes: 'found 2 transactions',
  });
  // Deliberately NOT a recognized column layout — the AI is responsible for
  // reading this itself, not a local header-matching parser.
  const freeform = 'June activity: spent $45.67 at Kroger on the 1st; got paid $2000 on the 3rd.';
  const r = await api('POST', '/api/transactions/import', { account_id: accountId, content: freeform });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 2);
  assert.equal(seenPayload.rawContent, freeform, 'the AI is handed the raw file verbatim');
  const list = await api('GET', `/api/transactions?account_id=${accountId}`);
  assert.equal(list.json.total, 2);
});

test('Markdown import flows through the same AI-analyzed pipeline', async () => {
  const accountId = await makeAccount();
  extraction = () => ({
    transactions: [{ date: '2026-06-04', payee: 'Coffee Shop', amount_cents: -525, memo: '' }],
    notes: 'ok',
  });
  const md = [
    '| Date | Description | Amount |',
    '|------|-------------|--------|',
    '| 06/04/2026 | Coffee Shop | -5.25 |',
  ].join('\n');
  const r = await api('POST', '/api/transactions/import', { account_id: accountId, content: md });
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'md');
  assert.equal(r.json.imported, 1);
});

test('invalid entries from the AI are skipped with an error, valid ones still import', async () => {
  const accountId = await makeAccount();
  extraction = () => ({
    transactions: [
      { date: 'not-a-date', payee: 'Bad Row', amount_cents: -100, memo: '' },
      { date: '2026-06-05', payee: 'Gas', amount_cents: -3000, memo: '' },
    ],
    notes: 'one row was ambiguous',
  });
  const r = await api('POST', '/api/transactions/import', { account_id: accountId, content: 'whatever' });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 1);
  assert.equal(r.json.errors.length, 1);
});

test('legacy { csv } field still works', async () => {
  const accountId = await makeAccount();
  extraction = () => ({ transactions: [{ date: '2026-06-05', payee: 'Gas', amount_cents: -3000, memo: '' }], notes: 'ok' });
  const r = await api('POST', '/api/transactions/import', {
    account_id: accountId,
    csv: 'Date,Description,Amount\n2026-06-05,Gas,-30.00',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 1);
});

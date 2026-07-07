'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const txmod = require('../server/transactions');

// --- unit: Markdown + format detection -----------------------------------
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

// --- integration: the mandatory AI gate -----------------------------------
// A stub verifier stands in for DeepSeek so tests are deterministic & offline.
let server, base, verdict, seenPayload;

function stubVerifier() {
  return async (payload) => { seenPayload = payload; return verdict(payload); };
}

before(async () => {
  server = createApp({ dbPath: ':memory:', verifyImport: stubVerifier() });
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

test('import is refused (nothing written) when the AI auditor does not verify', async () => {
  const accountId = await makeAccount();
  verdict = () => ({ verified: false, issues: [{ index: 0, field: 'amount', detail: 'sign flipped' }], notes: 'mismatch' });
  const r = await api('POST', '/api/transactions/import', {
    account_id: accountId,
    content: 'Date,Description,Amount\n2026-06-01,Kroger,-45.67',
  });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /could not verify/i);
  assert.equal(r.json.details.verification.issues[0].field, 'amount');
  const list = await api('GET', `/api/transactions?account_id=${accountId}`);
  assert.equal(list.json.total, 0, 'no transactions should be written on a failed audit');
});

test('import writes transactions only after the AI auditor verifies them', async () => {
  const accountId = await makeAccount();
  verdict = (p) => ({ verified: true, expected_count: p.candidates.length, issues: [], notes: 'looks good' });
  const csv = 'Date,Description,Amount\n2026-06-01,Kroger,-45.67\n2026-06-03,Paycheck,2000.00';
  const r = await api('POST', '/api/transactions/import', { account_id: accountId, content: csv });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 2);
  assert.equal(r.json.verification.verified, true);
  assert.equal(seenPayload.candidates.length, 2, 'auditor is handed the parsed candidates');
  assert.equal(seenPayload.candidates[0].amount_cents, -4567);
  const list = await api('GET', `/api/transactions?account_id=${accountId}`);
  assert.equal(list.json.total, 2);
});

test('Markdown import flows through the same audited pipeline', async () => {
  const accountId = await makeAccount();
  verdict = () => ({ verified: true, issues: [], notes: 'ok' });
  const md = [
    '| Date | Description | Amount |',
    '|------|-------------|--------|',
    '| 06/04/2026 | Coffee Shop | -5.25 |',
  ].join('\n');
  const r = await api('POST', '/api/transactions/import', { account_id: accountId, content: md });
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'md');
  assert.equal(r.json.imported, 1);
  assert.equal(seenPayload.candidates[0].date, '2026-06-04'); // MM/DD/YYYY normalized
});

test('legacy { csv } field still works', async () => {
  const accountId = await makeAccount();
  verdict = () => ({ verified: true, issues: [], notes: 'ok' });
  const r = await api('POST', '/api/transactions/import', {
    account_id: accountId,
    csv: 'Date,Description,Amount\n2026-06-05,Gas,-30.00',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 1);
});

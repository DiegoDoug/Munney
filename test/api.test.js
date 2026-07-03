'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');

let server, base;

before(async () => {
  server = createApp({ dbPath: ':memory:' });
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
  const json = await res.json();
  return { status: res.status, json };
}

test('end-to-end API flow: account -> income -> assign -> spend -> reports', async () => {
  // create account with opening balance (counts as income / RTA)
  let r = await api('POST', '/api/accounts', { name: 'Checking', type: 'checking', balance_cents: 250000, balance_date: '2026-06-01' });
  assert.equal(r.status, 200);
  const acctId = r.json.account.id;
  assert.equal(r.json.account.balance_cents, 250000);

  // budget shows RTA = opening balance
  r = await api('GET', '/api/budget/2026-06');
  assert.equal(r.json.ready_to_assign, 250000);

  // find Groceries category
  r = await api('GET', '/api/categories');
  const groceries = r.json.groups.flatMap(g => g.categories).find(c => c.name === 'Groceries');
  assert.ok(groceries);

  // assign money
  r = await api('PUT', `/api/budget/2026-06/${groceries.id}`, { assigned_cents: 40000 });
  assert.equal(r.json.ready_to_assign, 210000);

  // spend
  r = await api('POST', '/api/transactions', {
    account_id: acctId, date: '2026-06-10', payee: 'Kroger', category_id: groceries.id, amount_cents: -12000,
  });
  assert.equal(r.status, 200);

  r = await api('GET', '/api/budget/2026-06');
  const row = r.json.groups.flatMap(g => g.categories).find(c => c.id === groceries.id);
  assert.equal(row.activity_cents, -12000);
  assert.equal(row.available_cents, 28000);

  // spending report
  r = await api('GET', '/api/reports/spending?month=2026-06');
  assert.equal(r.json.categories.length, 1);
  assert.equal(r.json.categories[0].spent_cents, 12000);

  // dashboard aggregates
  r = await api('GET', '/api/dashboard?month=2026-06');
  assert.equal(r.json.income_cents, 250000);
  assert.equal(r.json.spent_cents, 12000);
  assert.equal(r.json.net_worth_cents, 238000);
  assert.equal(r.json.recent_transactions.length, 2);

  // net worth report
  r = await api('GET', '/api/reports/networth?month=2026-06&months=2');
  const nw = r.json.months;
  assert.equal(nw[nw.length - 1].net_worth_cents, 238000);
});

test('validation errors return 400', async () => {
  let r = await api('POST', '/api/accounts', { name: '' });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/transactions', { account_id: 9999, date: '2026-06-01', amount_cents: -100 });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/transactions', { account_id: 1, date: 'junk', amount_cents: -100 });
  assert.equal(r.status, 400);
  r = await api('GET', '/api/budget/not-a-month');
  assert.equal(r.status, 400);
});

test('category and group management', async () => {
  let r = await api('POST', '/api/category-groups', { name: 'Pets' });
  const gid = r.json.id;
  r = await api('POST', '/api/categories', { group_id: gid, name: 'Vet', target_cents: 5000 });
  const cid = r.json.id;
  r = await api('GET', '/api/categories');
  const pets = r.json.groups.find(g => g.id === gid);
  assert.ok(pets);
  assert.equal(pets.categories[0].name, 'Vet');
  assert.equal(pets.categories[0].target_cents, 5000);

  r = await api('PATCH', `/api/categories/${cid}`, { name: 'Veterinary', target_cents: 7500 });
  assert.equal(r.status, 200);
  r = await api('DELETE', `/api/categories/${cid}`);
  assert.equal(r.status, 200);
});

test('transactions filtering and search', async () => {
  let r = await api('GET', '/api/transactions?search=Kroger');
  assert.equal(r.json.transactions.length, 1);
  r = await api('GET', '/api/transactions?month=2026-06');
  assert.ok(r.json.transactions.length >= 2);
  r = await api('GET', '/api/transactions?month=1999-01');
  assert.equal(r.json.transactions.length, 0);
});

test('recurring endpoint shape', async () => {
  const r = await api('GET', '/api/recurring');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.series));
  assert.equal(typeof r.json.total_monthly_cost_cents, 'number');
});

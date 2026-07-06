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

test('group rename, reorder, and delete cascade', async () => {
  let r = await api('POST', '/api/category-groups', { name: 'Alpha' });
  const g1 = r.json.id;
  r = await api('POST', '/api/category-groups', { name: 'Beta' });
  const g2 = r.json.id;
  // rename
  r = await api('PATCH', `/api/category-groups/${g1}`, { name: 'Alpha One' });
  assert.equal(r.status, 200);
  // reorder: g2 before g1
  r = await api('POST', '/api/category-groups/reorder', { ids: [g2, g1] });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/categories');
  const idx1 = r.json.groups.findIndex(g => g.id === g1);
  const idx2 = r.json.groups.findIndex(g => g.id === g2);
  assert.ok(idx2 < idx1);
  // category in g1, then delete group detaches transaction
  r = await api('POST', '/api/categories', { group_id: g1, name: 'Temp' });
  const cid = r.json.id;
  const acctId = (await api('GET', '/api/accounts')).json.accounts[0].id;
  r = await api('POST', '/api/transactions', { account_id: acctId, date: '2026-06-15', payee: 'X', category_id: cid, amount_cents: -100 });
  const txnId = r.json.transaction.id;
  r = await api('DELETE', `/api/category-groups/${g1}`);
  assert.equal(r.status, 200);
  r = await api('GET', `/api/transactions?search=X`);
  const t = r.json.transactions.find(x => x.id === txnId);
  assert.equal(t.category_id, null);
});

test('category reorder, group move, and hide', async () => {
  const g = (await api('POST', '/api/category-groups', { name: 'MoveTest' })).json.id;
  const other = (await api('POST', '/api/category-groups', { name: 'Dest' })).json.id;
  const a = (await api('POST', '/api/categories', { group_id: g, name: 'A' })).json.id;
  const b = (await api('POST', '/api/categories', { group_id: g, name: 'B' })).json.id;
  let r = await api('POST', '/api/categories/reorder', { ids: [b, a] });
  assert.equal(r.status, 200);
  r = await api('PATCH', `/api/categories/${a}`, { group_id: other, hidden: true });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/categories');
  const dest = r.json.groups.find(x => x.id === other);
  assert.ok(dest.categories.find(c => c.id === a));
});

test('account edit type/on_budget and delete', async () => {
  let r = await api('POST', '/api/accounts', { name: 'Card', type: 'checking', balance_cents: 0 });
  const id = r.json.account.id;
  // switch to credit -> gains a payment category
  r = await api('PATCH', `/api/accounts/${id}`, { type: 'credit' });
  assert.equal(r.json.account.type, 'credit');
  // switch back -> payment category removed, on_budget off
  r = await api('PATCH', `/api/accounts/${id}`, { type: 'savings', on_budget: 0 });
  assert.equal(r.json.account.on_budget, 0);
  r = await api('DELETE', `/api/accounts/${id}`);
  assert.equal(r.status, 200);
  r = await api('PATCH', `/api/accounts/${id}`, { name: 'x' });
  assert.equal(r.status, 404);
});

test('payee rules can be set and deleted', async () => {
  const cat = (await api('GET', '/api/categories')).json.groups.flatMap(g => g.categories)[0];
  let r = await api('PUT', `/api/payee-rules/${encodeURIComponent('some payee')}`, { category_id: cat.id });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/payee-rules');
  assert.ok(r.json.rules.find(x => x.payee_norm === 'some payee'));
  r = await api('DELETE', `/api/payee-rules/${encodeURIComponent('some payee')}`);
  assert.equal(r.status, 200);
  r = await api('DELETE', `/api/payee-rules/${encodeURIComponent('some payee')}`);
  assert.equal(r.status, 404);
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

// Must run last: it wipes the shared in-memory database.
test('reset wipes data back to a fresh install', async () => {
  let r = await api('POST', '/api/reset', {});
  assert.equal(r.status, 200);
  r = await api('GET', '/api/accounts');
  assert.equal(r.json.accounts.length, 0);
  r = await api('GET', '/api/transactions');
  assert.equal(r.json.total, 0);
  // starter categories restored by default
  r = await api('GET', '/api/categories');
  assert.ok(r.json.groups.length > 0);

  // reset without starter categories leaves it blank
  r = await api('POST', '/api/reset', { keep_starter_categories: false });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/categories');
  assert.equal(r.json.groups.length, 0);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { open, incomeCategoryId } = require('../server/db');
const budget = require('../server/budget');
const { ageOfMoney } = require('../server/aom');
const tx = require('../server/transactions');

function setup() {
  const db = open(':memory:');
  const cash = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Checking', 'checking', 1)").run().lastInsertRowid;
  return { db, cash, incomeId: incomeCategoryId(db) };
}
const catId = (db, name) => db.prepare('SELECT id FROM categories WHERE name = ? AND payment_account_id IS NULL').get(name).id;
const row = (db, month, id) => budget.budgetForMonth(db, month).groups.flatMap(g => g.categories).find(c => c.id === id);

// ---------- target-by-date goals ----------

test('by_date goal: spreads the remainder over months left', () => {
  const { db } = setup();
  const vac = catId(db, 'Vacation');
  db.prepare("UPDATE categories SET target_cents = 120000, target_type = 'by_date', target_date = '2026-12' WHERE id = ?").run(vac);

  // June view: 7 months left (Jun..Dec), nothing saved yet -> ~$171.43/mo
  let g = row(db, '2026-06', vac).goal;
  assert.equal(g.type, 'by_date');
  assert.equal(g.months_left, 7);
  assert.equal(g.needed_per_month_cents, Math.ceil(120000 / 7));
  assert.equal(g.status, 'behind');

  // assign exactly the suggestion -> on track
  budget.setAssigned(db, '2026-06', vac, g.needed_per_month_cents);
  g = row(db, '2026-06', vac).goal;
  assert.equal(g.status, 'on_track');

  // July: suggestion accounts for what's already saved (6 months left)
  g = row(db, '2026-07', vac).goal;
  assert.equal(g.months_left, 6);
  assert.equal(g.needed_per_month_cents, Math.ceil((120000 - Math.ceil(120000 / 7)) / 6));
});

test('by_date goal: funded and overdue states', () => {
  const { db } = setup();
  const vac = catId(db, 'Vacation');
  db.prepare("UPDATE categories SET target_cents = 50000, target_type = 'by_date', target_date = '2026-05' WHERE id = ?").run(vac);

  // viewing a month after the deadline with nothing saved -> overdue, full amount due now
  let g = row(db, '2026-06', vac).goal;
  assert.equal(g.status, 'overdue');
  assert.equal(g.months_left, 1);
  assert.equal(g.needed_per_month_cents, 50000);

  budget.setAssigned(db, '2026-04', vac, 50000);
  g = row(db, '2026-06', vac).goal;
  assert.equal(g.status, 'funded');
});

test('monthly goal keeps its existing semantics', () => {
  const { db } = setup();
  const groc = catId(db, 'Groceries');
  db.prepare('UPDATE categories SET target_cents = 40000 WHERE id = ?').run(groc);
  assert.equal(row(db, '2026-06', groc).goal.status, 'behind');
  budget.setAssigned(db, '2026-06', groc, 40000);
  assert.equal(row(db, '2026-06', groc).goal.status, 'funded');
});

// ---------- age of money ----------

test('AoM: simple case — spend 10 days after the only income', () => {
  const { db, cash, incomeId } = setup();
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 100000 });
  tx.createTransaction(db, { account_id: cash, date: '2026-06-11', payee: 'Shop', category_id: catId(db, 'Groceries'), amount_cents: -5000 });
  assert.deepEqual(ageOfMoney(db, '2026-06-30'), { days: 10, sample_size: 1 });
});

test('AoM: FIFO — old money is spent before new money', () => {
  const { db, cash, incomeId } = setup();
  const groc = catId(db, 'Groceries');
  tx.createTransaction(db, { account_id: cash, date: '2026-05-01', payee: 'Job', category_id: incomeId, amount_cents: 10000 });
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 10000 });
  // consumes all of May's $100 (age 40) and half of June's (age 9)
  tx.createTransaction(db, { account_id: cash, date: '2026-06-10', payee: 'Shop', category_id: groc, amount_cents: -15000 });
  const age1 = (10000 * 40 + 5000 * 9) / 15000;
  assert.equal(ageOfMoney(db, '2026-06-30').days, Math.round(age1));

  // a later spend consumes the rest of June's income (age 15)
  tx.createTransaction(db, { account_id: cash, date: '2026-06-16', payee: 'Shop', category_id: groc, amount_cents: -5000 });
  assert.equal(ageOfMoney(db, '2026-06-30').days, Math.round((age1 + 15) / 2));
});

test('AoM: card swipes do not age money, the card payment does', () => {
  const { db, cash, incomeId } = setup();
  const card = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Visa', 'credit', 1)").run().lastInsertRowid;
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 50000 });
  tx.createTransaction(db, { account_id: card, date: '2026-06-05', payee: 'Kroger', category_id: catId(db, 'Groceries'), amount_cents: -8000 });
  assert.equal(ageOfMoney(db, '2026-06-30'), null); // no cash has left yet
  tx.createTransaction(db, { account_id: cash, date: '2026-06-21', transfer_account_id: card, amount_cents: -8000 });
  assert.deepEqual(ageOfMoney(db, '2026-06-30'), { days: 20, sample_size: 1 });
});

test('AoM: transfers between on-budget cash accounts are ignored', () => {
  const { db, cash, incomeId } = setup();
  const savings = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Savings', 'savings', 1)").run().lastInsertRowid;
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 50000 });
  tx.createTransaction(db, { account_id: cash, date: '2026-06-15', transfer_account_id: savings, amount_cents: -20000 });
  assert.equal(ageOfMoney(db, '2026-06-30'), null);
});

test('AoM: averages only the last 10 outflows', () => {
  const { db, cash, incomeId } = setup();
  const groc = catId(db, 'Groceries');
  tx.createTransaction(db, { account_id: cash, date: '2026-01-01', payee: 'Job', category_id: incomeId, amount_cents: 1000000 });
  // 11 spends of $1 on consecutive days starting Jun 1 (ages 151..161)
  for (let i = 0; i < 11; i++) {
    const d = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
    tx.createTransaction(db, { account_id: cash, date: d, payee: 'Shop', category_id: groc, amount_cents: -100 });
  }
  const r = ageOfMoney(db, '2026-06-30');
  assert.equal(r.sample_size, 10);
  // last 10 spends have ages 152..161 -> mean 156.5 -> rounds to 157
  assert.equal(r.days, 157);
});

test('AoM: null with no income or no spending', () => {
  const { db, cash, incomeId } = setup();
  assert.equal(ageOfMoney(db, '2026-06-30'), null);
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 50000 });
  assert.equal(ageOfMoney(db, '2026-06-30'), null);
});

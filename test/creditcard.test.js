'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { open, incomeCategoryId } = require('../server/db');
const budget = require('../server/budget');
const tx = require('../server/transactions');

function setup() {
  const db = open(':memory:');
  const cash = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Checking', 'checking', 1)").run().lastInsertRowid;
  const card = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Visa', 'credit', 1)").run().lastInsertRowid;
  // open() only ensures payment categories for accounts that existed at open time
  const { ensurePaymentCategory } = require('../server/db');
  const ccCatId = ensurePaymentCategory(db, card, 'Visa');
  return { db, cash, card, ccCatId, incomeId: incomeCategoryId(db) };
}

const catId = (db, name) => db.prepare('SELECT id FROM categories WHERE name = ? AND payment_account_id IS NULL').get(name).id;
const row = (db, month, id) => budget.budgetForMonth(db, month).groups.flatMap(g => g.categories).find(c => c.id === id);

test('budgeted card spending moves money into the payment category', () => {
  const { db, cash, card, ccCatId, incomeId } = setup();
  const groceries = catId(db, 'Groceries');
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 100000 });
  budget.setAssigned(db, '2026-06', groceries, 30000);
  tx.createTransaction(db, { account_id: card, date: '2026-06-10', payee: 'Kroger', category_id: groceries, amount_cents: -8000 });

  const g = row(db, '2026-06', groceries);
  assert.equal(g.activity_cents, -8000);
  assert.equal(g.available_cents, 22000);      // envelope drained as usual
  const cc = row(db, '2026-06', ccCatId);
  assert.equal(cc.activity_cents, 8000);        // money set aside for the payment
  assert.equal(cc.available_cents, 8000);
  assert.ok(cc.payment_account_id);
});

test('paying the card (transfer) draws down the payment category', () => {
  const { db, cash, card, ccCatId, incomeId } = setup();
  const groceries = catId(db, 'Groceries');
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 100000 });
  tx.createTransaction(db, { account_id: card, date: '2026-06-10', payee: 'Kroger', category_id: groceries, amount_cents: -8000 });
  tx.createTransaction(db, { account_id: cash, date: '2026-06-20', transfer_account_id: card, amount_cents: -8000 });

  const cc = row(db, '2026-06', ccCatId);
  assert.equal(cc.available_cents, 0);          // fully paid
  const balances = budget.accountBalances(db);
  assert.equal(balances.find(a => a.id === card).balance_cents, 0);
  assert.equal(balances.find(a => a.id === cash).balance_cents, 92000);
});

test('card starting balance (pre-existing debt) does not create payment funds', () => {
  const { db, card, ccCatId } = setup();
  // uncategorized, like the account-creation route records it
  db.prepare('INSERT INTO transactions (account_id, date, payee, amount_cents) VALUES (?, ?, ?, ?)')
    .run(card, '2026-06-01', 'Starting Balance', -50000);
  const cc = row(db, '2026-06', ccCatId);
  assert.equal(cc.available_cents, 0);
  // budgeting for the old debt is a direct assignment
  budget.setAssigned(db, '2026-06', ccCatId, 50000);
  assert.equal(row(db, '2026-06', ccCatId).available_cents, 50000);
});

test('invariant: RTA + total available == cash funds (excluding cards)', () => {
  const { db, cash, card, incomeId } = setup();
  const groceries = catId(db, 'Groceries'), dining = catId(db, 'Dining Out');
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 300000 });
  budget.setAssigned(db, '2026-06', groceries, 50000);
  budget.setAssigned(db, '2026-06', dining, 20000);
  tx.createTransaction(db, { account_id: card, date: '2026-06-05', payee: 'Kroger', category_id: groceries, amount_cents: -20000 });
  tx.createTransaction(db, { account_id: cash, date: '2026-06-08', payee: 'Cafe', category_id: dining, amount_cents: -4000 });
  tx.createTransaction(db, { account_id: cash, date: '2026-06-20', transfer_account_id: card, amount_cents: -15000 }); // partial payment

  const b = budget.budgetForMonth(db, '2026-06');
  const cashFunds = budget.accountBalances(db)
    .filter(a => a.on_budget && a.type !== 'credit')
    .reduce((s, a) => s + a.balance_cents, 0);
  assert.equal(b.ready_to_assign + b.total_available_cents, cashFunds);
});

test('cannot categorize a transaction to a payment category, and no rules are learned', () => {
  const { db, cash, ccCatId } = setup();
  assert.throws(
    () => tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Visa', category_id: ccCatId, amount_cents: -5000 }),
    /payment category/);
  const { suggestCategory } = require('../server/categorize');
  assert.equal(suggestCategory(db, 'Visa'), null);
});

test('card refunds flow back: category refilled, payment need reduced', () => {
  const { db, cash, card, ccCatId, incomeId } = setup();
  const shopping = catId(db, 'Shopping');
  tx.createTransaction(db, { account_id: cash, date: '2026-06-01', payee: 'Job', category_id: incomeId, amount_cents: 100000 });
  tx.createTransaction(db, { account_id: card, date: '2026-06-05', payee: 'Amazon', category_id: shopping, amount_cents: -9000 });
  tx.createTransaction(db, { account_id: card, date: '2026-06-12', payee: 'Amazon', category_id: shopping, amount_cents: 9000 }); // full refund
  assert.equal(row(db, '2026-06', shopping).available_cents, 0);
  assert.equal(row(db, '2026-06', ccCatId).available_cents, 0);
});

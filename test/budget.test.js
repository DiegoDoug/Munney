'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { open, incomeCategoryId } = require('../server/db');
const budget = require('../server/budget');
const tx = require('../server/transactions');

function setup() {
  const db = open(':memory:');
  const acctId = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Checking', 'checking', 1)").run().lastInsertRowid;
  return { db, acctId, incomeId: incomeCategoryId(db) };
}

function catId(db, name) {
  return db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
}

test('income flows into Ready to Assign', () => {
  const { db, acctId, incomeId } = setup();
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-01', payee: 'Employer', category_id: incomeId, amount_cents: 300000 });
  assert.equal(budget.readyToAssign(db, '2026-06'), 300000);
  // future months see the same money
  assert.equal(budget.readyToAssign(db, '2026-07'), 300000);
  // months before the income don't
  assert.equal(budget.readyToAssign(db, '2026-05'), 0);
});

test('assigning reduces RTA; spending reduces Available not RTA', () => {
  const { db, acctId, incomeId } = setup();
  const groceries = catId(db, 'Groceries');
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-01', payee: 'Employer', category_id: incomeId, amount_cents: 200000 });
  budget.setAssigned(db, '2026-06', groceries, 50000);
  assert.equal(budget.readyToAssign(db, '2026-06'), 150000);

  tx.createTransaction(db, { account_id: acctId, date: '2026-06-10', payee: 'Kroger', category_id: groceries, amount_cents: -12345 });
  const b = budget.budgetForMonth(db, '2026-06');
  const row = b.groups.flatMap(g => g.categories).find(c => c.id === groceries);
  assert.equal(row.assigned_cents, 50000);
  assert.equal(row.activity_cents, -12345);
  assert.equal(row.available_cents, 37655);
  assert.equal(b.ready_to_assign, 150000); // spending doesn't touch RTA
});

test('available rolls over across months, including overspending', () => {
  const { db, acctId, incomeId } = setup();
  const dining = catId(db, 'Dining Out');
  tx.createTransaction(db, { account_id: acctId, date: '2026-05-01', payee: 'Employer', category_id: incomeId, amount_cents: 100000 });
  budget.setAssigned(db, '2026-05', dining, 10000);
  tx.createTransaction(db, { account_id: acctId, date: '2026-05-20', payee: 'Cafe', category_id: dining, amount_cents: -4000 });

  let row = budget.budgetForMonth(db, '2026-06').groups.flatMap(g => g.categories).find(c => c.id === dining);
  assert.equal(row.assigned_cents, 0);        // nothing assigned in June
  assert.equal(row.available_cents, 6000);    // May leftover rolls over

  tx.createTransaction(db, { account_id: acctId, date: '2026-06-15', payee: 'Steakhouse', category_id: dining, amount_cents: -9000 });
  row = budget.budgetForMonth(db, '2026-06').groups.flatMap(g => g.categories).find(c => c.id === dining);
  assert.equal(row.available_cents, -3000);   // overspent carries negative
  row = budget.budgetForMonth(db, '2026-07').groups.flatMap(g => g.categories).find(c => c.id === dining);
  assert.equal(row.available_cents, -3000);   // and persists into July
});

test('invariant: RTA + total available == on-budget funds', () => {
  const { db, acctId, incomeId } = setup();
  const g = catId(db, 'Groceries'), r = catId(db, 'Rent/Mortgage');
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-01', payee: 'Employer', category_id: incomeId, amount_cents: 400000 });
  budget.setAssigned(db, '2026-06', g, 60000);
  budget.setAssigned(db, '2026-06', r, 150000);
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-05', payee: 'Landlord', category_id: r, amount_cents: -150000 });
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-08', payee: 'Kroger', category_id: g, amount_cents: -22000 });

  const b = budget.budgetForMonth(db, '2026-06');
  const funds = budget.accountBalances(db).filter(a => a.on_budget).reduce((s, a) => s + a.balance_cents, 0);
  assert.equal(b.ready_to_assign + b.total_available_cents, funds);
});

test('off-budget accounts do not affect the budget', () => {
  const { db, acctId, incomeId } = setup();
  const invId = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Brokerage', 'investment', 0)").run().lastInsertRowid;
  tx.createTransaction(db, { account_id: invId, date: '2026-06-01', payee: 'Employer', category_id: incomeId, amount_cents: 999999 });
  assert.equal(budget.readyToAssign(db, '2026-06'), 0);
});

test('transfers move money without touching categories or RTA', () => {
  const { db, acctId, incomeId } = setup();
  const savId = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Savings', 'savings', 1)").run().lastInsertRowid;
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-01', payee: 'Employer', category_id: incomeId, amount_cents: 100000 });
  tx.createTransaction(db, { account_id: acctId, date: '2026-06-02', transfer_account_id: savId, amount_cents: -30000 });

  const balances = budget.accountBalances(db);
  assert.equal(balances.find(a => a.id === acctId).balance_cents, 70000);
  assert.equal(balances.find(a => a.id === savId).balance_cents, 30000);
  assert.equal(budget.readyToAssign(db, '2026-06'), 100000); // unchanged: both on-budget

  // deleting one leg removes both
  const leg = db.prepare('SELECT id FROM transactions WHERE transfer_pair_id IS NOT NULL LIMIT 1').get();
  tx.deleteTransaction(db, leg.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE transfer_pair_id IS NOT NULL').get().n, 0);
});

test('month helpers', () => {
  assert.equal(budget.prevMonth('2026-01'), '2025-12');
  assert.equal(budget.nextMonth('2025-12'), '2026-01');
  assert.equal(budget.nextMonth('2026-06'), '2026-07');
});

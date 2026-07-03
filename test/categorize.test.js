'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../server/db');
const { normalizePayee, learnRule, suggestCategory } = require('../server/categorize');
const tx = require('../server/transactions');

test('normalizePayee strips noise', () => {
  assert.equal(normalizePayee('STARBUCKS #1234'), 'starbucks');
  assert.equal(normalizePayee('AMZN Mktp US*RT4567'), 'amzn mktp us');
  assert.equal(normalizePayee('Kroger 00423 MOBILE AL'), 'kroger mobile al');
});

test('learns from manual categorization and applies to new transactions', () => {
  const db = open(':memory:');
  const acct = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('C','checking',1)").run().lastInsertRowid;
  const groceries = db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get().id;

  // uncategorized at first
  const t1 = tx.createTransaction(db, { account_id: acct, date: '2026-06-01', payee: 'KROGER #421', amount_cents: -5000 });
  assert.equal(t1.category_id, null);

  // user categorizes it -> rule learned
  tx.updateTransaction(db, t1.id, { category_id: groceries });
  assert.equal(suggestCategory(db, 'KROGER #999'), groceries);

  // next transaction with same payee auto-categorizes
  const t2 = tx.createTransaction(db, { account_id: acct, date: '2026-06-08', payee: 'KROGER #77', amount_cents: -6200 });
  assert.equal(t2.category_id, groceries);
});

test('CSV import: parses, dedupes, auto-categorizes', () => {
  const db = open(':memory:');
  const acct = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('C','checking',1)").run().lastInsertRowid;
  const groceries = db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get().id;
  learnRule(db, 'Trader Joes', groceries);

  const csv = [
    'Date,Description,Amount',
    '2026-06-01,"Employer, Inc. Payroll",3000.00',
    '06/03/2026,TRADER JOES #55,-45.67',
    '2026-06-05,Mystery Shop,(12.34)',
  ].join('\n');

  const r1 = tx.importCSV(db, acct, csv);
  assert.equal(r1.imported, 3);
  assert.equal(r1.skipped_duplicates, 0);
  assert.equal(r1.auto_categorized, 1);

  // re-import is a no-op
  const r2 = tx.importCSV(db, acct, csv);
  assert.equal(r2.imported, 0);
  assert.equal(r2.skipped_duplicates, 3);

  const rows = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].amount_cents, 300000);
  // inflow defaulted to income category
  const income = db.prepare('SELECT id FROM categories WHERE is_income = 1').get().id;
  assert.equal(rows[0].category_id, income);
  assert.equal(rows[1].amount_cents, -4567);
  assert.equal(rows[1].category_id, groceries); // learned rule applied
  assert.equal(rows[2].amount_cents, -1234);    // parenthesized negative
});

test('CSV import: debit/credit column format', () => {
  const db = open(':memory:');
  const acct = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('C','checking',1)").run().lastInsertRowid;
  const csv = [
    'Date,Description,Debit,Credit',
    '2026-06-02,Coffee Shop,4.50,',
    '2026-06-03,Refund,,10.00',
  ].join('\n');
  const r = tx.importCSV(db, acct, csv);
  assert.equal(r.imported, 2);
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  assert.equal(rows[0].amount_cents, -450);
  assert.equal(rows[1].amount_cents, 1000);
});

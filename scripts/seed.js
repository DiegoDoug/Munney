'use strict';
// Seeds a demo dataset (6 months of realistic history) so the app has something
// to show on first run. Usage: npm run seed  (writes to data/munney.db, or MUNNEY_DB)
const path = require('node:path');
const fs = require('node:fs');
const { open, incomeCategoryId } = require('../server/db');
const budget = require('../server/budget');
const tx = require('../server/transactions');

const DB_PATH = process.env.MUNNEY_DB || path.join(__dirname, '..', 'data', 'munney.db');
if (fs.existsSync(DB_PATH)) {
  console.error(`Refusing to seed: ${DB_PATH} already exists. Delete it first if you want demo data.`);
  process.exit(1);
}
const db = open(DB_PATH);
const incomeId = incomeCategoryId(db);
const cat = name => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

const checking = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Checking', 'checking', 1)").run().lastInsertRowid;
const savings = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Savings', 'savings', 1)").run().lastInsertRowid;
const credit = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Credit Card', 'credit', 1)").run().lastInsertRowid;
const brokerage = db.prepare("INSERT INTO accounts (name, type, on_budget) VALUES ('Brokerage', 'investment', 0)").run().lastInsertRowid;

const now = new Date();
const month = d => d.toISOString().slice(0, 7);
const iso = d => d.toISOString().slice(0, 10);
function m(offset, day) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day));
  return iso(d);
}
const rnd = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));

const add = (account_id, date, payee, category, cents) =>
  tx.createTransaction(db, { account_id, date, payee, category_id: category, amount_cents: cents });

// opening balances 6 months ago
add(checking, m(-6, 1), 'Starting Balance', incomeId, 320000);
add(savings, m(-6, 1), 'Starting Balance', incomeId, 800000);
db.prepare('INSERT INTO transactions (account_id, date, payee, amount_cents) VALUES (?, ?, ?, ?)')
  .run(brokerage, m(-6, 1), 'Starting Balance', 1500000);

for (let mo = -6; mo <= 0; mo++) {
  const last = mo === 0;
  const dayCap = last ? now.getUTCDate() : 28;
  const paid = day => !last || day <= dayCap;

  if (paid(1)) add(checking, m(mo, 1), 'Acme Corp Payroll', incomeId, 260000);
  if (paid(15)) add(checking, m(mo, 15), 'Acme Corp Payroll', incomeId, 260000);
  if (paid(2)) add(checking, m(mo, 2), 'Oakwood Apartments', cat('Rent/Mortgage'), -145000);
  if (paid(5)) add(checking, m(mo, 5), 'City Power & Light', cat('Utilities'), -rnd(7500, 11500));
  if (paid(8)) add(checking, m(mo, 8), 'FiberNet Internet', cat('Internet'), -6999);
  if (paid(12)) add(checking, m(mo, 12), 'T-Mobile', cat('Phone'), -8500);
  if (paid(15)) add(credit, m(mo, 15), 'Netflix.com', cat('Streaming'), -1599);
  if (paid(20)) add(credit, m(mo, 20), 'Spotify USA', cat('Streaming'), -1199);
  if (paid(22)) add(credit, m(mo, 22), 'PLANET FIT #1234', cat('Memberships'), -2499);

  for (const day of [3, 10, 17, 24]) {
    if (paid(day)) add(credit, m(mo, day), 'Kroger #421', cat('Groceries'), -rnd(6000, 14000));
  }
  for (let i = 0; i < 5; i++) {
    const day = rnd(2, dayCap);
    add(credit, m(mo, day), ['Chipotle', 'Thai Basil', 'Corner Cafe', 'Pizza Palace'][rnd(0, 3)], cat('Dining Out'), -rnd(1200, 5200));
  }
  const gasDay1 = rnd(4, 12), gasDay2 = rnd(16, 26);
  if (paid(gasDay1)) add(credit, m(mo, gasDay1), 'Shell Oil', cat('Transportation'), -rnd(3200, 5200));
  if (paid(gasDay2)) add(credit, m(mo, gasDay2), 'Shell Oil', cat('Transportation'), -rnd(3200, 5200));
  if (paid(18)) add(credit, m(mo, 18), 'Amazon.com', cat('Shopping'), -rnd(1500, 9000));

  // pay off the card from checking and stash some savings
  if (paid(26)) {
    const owed = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE account_id = ?').get(credit).s;
    if (owed < 0) tx.createTransaction(db, { account_id: checking, date: m(mo, 26), transfer_account_id: credit, amount_cents: owed });
    tx.createTransaction(db, { account_id: checking, date: m(mo, 26), transfer_account_id: savings, amount_cents: -50000 });
  }

  // budget: assign to match the plan
  const mm = month(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + mo, 15)));
  for (const [name, cents] of [
    ['Rent/Mortgage', 145000], ['Utilities', 10000], ['Internet', 6999], ['Phone', 8500],
    ['Groceries', 45000], ['Dining Out', 20000], ['Transportation', 10000], ['Shopping', 8000],
    ['Streaming', 2800], ['Memberships', 2500], ['Emergency Fund', 50000], ['Vacation', 20000],
  ]) budget.setAssigned(db, mm, cat(name), cents);
}

// monthly targets
for (const [name, cents] of [
  ['Rent/Mortgage', 145000], ['Groceries', 45000], ['Dining Out', 20000],
  ['Emergency Fund', 50000], ['Vacation', 20000],
]) db.prepare('UPDATE categories SET target_cents = ? WHERE name = ?').run(cents, name);

const rta = budget.readyToAssign(db, month(now));
console.log(`Seeded demo data into ${DB_PATH}`);
console.log(`Ready to Assign this month: $${(rta / 100).toFixed(2)}`);

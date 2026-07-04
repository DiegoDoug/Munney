'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('checking','savings','cash','credit','investment','loan')),
  on_budget INTEGER NOT NULL DEFAULT 1,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS category_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES category_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  target_cents INTEGER,
  target_type TEXT NOT NULL DEFAULT 'monthly',  -- 'monthly' | 'by_date'
  target_date TEXT,                             -- YYYY-MM, for by_date targets
  is_income INTEGER NOT NULL DEFAULT 0,
  payment_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,             -- YYYY-MM-DD
  payee TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,  -- outflow negative, inflow positive
  memo TEXT NOT NULL DEFAULT '',
  cleared INTEGER NOT NULL DEFAULT 0,
  transfer_pair_id TEXT,          -- shared uuid linking the two legs of a transfer
  import_hash TEXT,               -- dedupe key for CSV imports
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);

CREATE TABLE IF NOT EXISTS budget_allocations (
  month TEXT NOT NULL,            -- YYYY-MM
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  assigned_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, category_id)
);

CREATE TABLE IF NOT EXISTS payee_rules (
  payee_norm TEXT PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_GROUPS = [
  ['Bills', ['Rent/Mortgage', 'Utilities', 'Internet', 'Phone', 'Insurance']],
  ['Everyday', ['Groceries', 'Dining Out', 'Transportation', 'Shopping', 'Personal Care']],
  ['Subscriptions', ['Streaming', 'Software', 'Memberships']],
  ['Savings Goals', ['Emergency Fund', 'Vacation', 'Big Purchases']],
];

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seedSystemRows(db);
  ensurePaymentCategories(db);
  return db;
}

// Add columns introduced after v1 to databases created before them.
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(categories)').all().map(c => c.name));
  if (!cols.has('target_type')) db.exec("ALTER TABLE categories ADD COLUMN target_type TEXT NOT NULL DEFAULT 'monthly'");
  if (!cols.has('target_date')) db.exec('ALTER TABLE categories ADD COLUMN target_date TEXT');
  if (!cols.has('payment_account_id')) db.exec('ALTER TABLE categories ADD COLUMN payment_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE');
}

// YNAB-style: every credit card account gets a payment category in a dedicated
// group (is_system = 2: shown on the budget, hidden from transaction categorization).
const CC_GROUP = 'Credit Card Payments';

function ensurePaymentCategories(db) {
  const cards = db.prepare("SELECT id, name FROM accounts WHERE type = 'credit'").all();
  for (const card of cards) ensurePaymentCategory(db, card.id, card.name);
}

function ensurePaymentCategory(db, accountId, accountName) {
  const existing = db.prepare('SELECT id FROM categories WHERE payment_account_id = ?').get(accountId);
  if (existing) return existing.id;
  let group = db.prepare('SELECT id FROM category_groups WHERE is_system = 2').get();
  if (!group) {
    db.prepare('INSERT INTO category_groups (name, sort_order, is_system) VALUES (?, 999, 2)').run(CC_GROUP);
    group = db.prepare('SELECT id FROM category_groups WHERE is_system = 2').get();
  }
  const r = db.prepare('INSERT INTO categories (group_id, name, payment_account_id) VALUES (?, ?, ?)')
    .run(group.id, accountName, accountId);
  return r.lastInsertRowid;
}

function seedSystemRows(db) {
  const hasSystem = db.prepare('SELECT id FROM category_groups WHERE is_system = 1').get();
  if (!hasSystem) {
    db.prepare("INSERT INTO category_groups (name, sort_order, is_system) VALUES ('Internal', -1, 1)").run();
    const gid = db.prepare('SELECT id FROM category_groups WHERE is_system = 1').get().id;
    db.prepare("INSERT INTO categories (group_id, name, is_income, hidden) VALUES (?, 'Inflow: Ready to Assign', 1, 0)").run(gid);
  }
  const userGroups = db.prepare('SELECT COUNT(*) AS n FROM category_groups WHERE is_system = 0').get();
  if (userGroups.n === 0) {
    let gSort = 0;
    for (const [groupName, cats] of DEFAULT_GROUPS) {
      db.prepare('INSERT INTO category_groups (name, sort_order) VALUES (?, ?)').run(groupName, gSort++);
      const gid = db.prepare('SELECT id FROM category_groups WHERE name = ? AND is_system = 0').get(groupName).id;
      let cSort = 0;
      for (const c of cats) {
        db.prepare('INSERT INTO categories (group_id, name, sort_order) VALUES (?, ?, ?)').run(gid, c, cSort++);
      }
    }
  }
}

function incomeCategoryId(db) {
  return db.prepare('SELECT id FROM categories WHERE is_income = 1').get().id;
}

module.exports = { open, incomeCategoryId, ensurePaymentCategory };

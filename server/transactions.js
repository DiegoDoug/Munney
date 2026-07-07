'use strict';
const crypto = require('node:crypto');
const { learnRule, suggestCategory } = require('./categorize');
const { incomeCategoryId } = require('./db');

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw httpError(400, 'date must be YYYY-MM-DD');
  return date;
}

function httpError(status, message, data) {
  const e = new Error(message);
  e.status = status;
  if (data !== undefined) e.data = data;
  return e;
}

function createTransaction(db, input) {
  const { account_id, date, payee = '', memo = '', cleared = 0 } = input;
  const amount = Math.trunc(Number(input.amount_cents));
  if (!Number.isFinite(amount)) throw httpError(400, 'amount_cents must be an integer');
  assertDate(date);
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
  if (!account) throw httpError(400, 'unknown account_id');

  // Transfer: create both legs linked by a pair id, no category on either.
  if (input.transfer_account_id) {
    const other = db.prepare('SELECT id, name FROM accounts WHERE id = ?').get(input.transfer_account_id);
    if (!other) throw httpError(400, 'unknown transfer_account_id');
    if (other.id === account_id) throw httpError(400, 'cannot transfer to the same account');
    const pairId = crypto.randomUUID();
    const from = db.prepare('SELECT name FROM accounts WHERE id = ?').get(account_id);
    const ins = db.prepare(`
      INSERT INTO transactions (account_id, date, payee, amount_cents, memo, cleared, transfer_pair_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    ins.run(account_id, date, `Transfer to ${other.name}`, amount, memo, cleared ? 1 : 0, pairId);
    ins.run(other.id, date, `Transfer from ${from.name}`, -amount, memo, cleared ? 1 : 0, pairId);
    return getTransaction(db, db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  let categoryId = input.category_id ?? null;
  if (categoryId) {
    const cat = db.prepare('SELECT id, payment_account_id FROM categories WHERE id = ?').get(categoryId);
    if (!cat) throw httpError(400, 'unknown category_id');
    if (cat.payment_account_id) throw httpError(400, 'cannot categorize to a credit card payment category — pay the card with a transfer instead');
    learnRule(db, payee, categoryId);
  } else if (payee) {
    categoryId = suggestCategory(db, payee);
  }

  const r = db.prepare(`
    INSERT INTO transactions (account_id, date, payee, category_id, amount_cents, memo, cleared)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(account_id, date, payee, categoryId, amount, memo, cleared ? 1 : 0);
  return getTransaction(db, r.lastInsertRowid);
}

function getTransaction(db, id) {
  return db.prepare(`
    SELECT t.*, a.name AS account_name, c.name AS category_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ?
  `).get(id);
}

function updateTransaction(db, id, input) {
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!txn) throw httpError(404, 'transaction not found');

  const fields = {};
  if (input.date !== undefined) fields.date = assertDate(input.date);
  if (input.payee !== undefined) fields.payee = String(input.payee);
  if (input.memo !== undefined) fields.memo = String(input.memo);
  if (input.cleared !== undefined) fields.cleared = input.cleared ? 1 : 0;
  if (input.amount_cents !== undefined) {
    const amount = Math.trunc(Number(input.amount_cents));
    if (!Number.isFinite(amount)) throw httpError(400, 'amount_cents must be an integer');
    fields.amount_cents = amount;
  }
  if (input.category_id !== undefined && !txn.transfer_pair_id) {
    if (input.category_id !== null) {
      const cat = db.prepare('SELECT id, payment_account_id FROM categories WHERE id = ?').get(input.category_id);
      if (!cat) throw httpError(400, 'unknown category_id');
      if (cat.payment_account_id) throw httpError(400, 'cannot categorize to a credit card payment category — pay the card with a transfer instead');
      learnRule(db, input.payee !== undefined ? input.payee : txn.payee, input.category_id);
    }
    fields.category_id = input.category_id;
  }

  const keys = Object.keys(fields);
  if (keys.length) {
    db.prepare(`UPDATE transactions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => fields[k]), id);
    // Keep the other leg of a transfer in sync for date/amount changes.
    if (txn.transfer_pair_id && (fields.date !== undefined || fields.amount_cents !== undefined)) {
      const pair = db.prepare(
        'SELECT id FROM transactions WHERE transfer_pair_id = ? AND id != ?'
      ).get(txn.transfer_pair_id, id);
      if (pair) {
        if (fields.date !== undefined) db.prepare('UPDATE transactions SET date = ? WHERE id = ?').run(fields.date, pair.id);
        if (fields.amount_cents !== undefined) db.prepare('UPDATE transactions SET amount_cents = ? WHERE id = ?').run(-fields.amount_cents, pair.id);
      }
    }
  }
  return getTransaction(db, id);
}

function deleteTransaction(db, id) {
  const txn = db.prepare('SELECT transfer_pair_id FROM transactions WHERE id = ?').get(id);
  if (!txn) throw httpError(404, 'transaction not found');
  if (txn.transfer_pair_id) {
    db.prepare('DELETE FROM transactions WHERE transfer_pair_id = ?').run(txn.transfer_pair_id);
  } else {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  }
}

function listTransactions(db, q) {
  const where = ['1=1'];
  const params = [];
  if (q.account_id) { where.push('t.account_id = ?'); params.push(Number(q.account_id)); }
  if (q.category_id) { where.push('t.category_id = ?'); params.push(Number(q.category_id)); }
  if (q.month) { where.push("substr(t.date, 1, 7) = ?"); params.push(q.month); }
  if (q.uncategorized === '1') { where.push('t.category_id IS NULL AND t.transfer_pair_id IS NULL'); }
  if (q.search) {
    where.push('(t.payee LIKE ? OR t.memo LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`);
  }
  const limit = Math.min(Number(q.limit) || 200, 1000);
  const offset = Number(q.offset) || 0;
  const rows = db.prepare(`
    SELECT t.*, a.name AS account_name, c.name AS category_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM transactions t WHERE ${where.join(' AND ')}
  `).get(...params).n;
  return { transactions: rows, total };
}

// --- File import (CSV + Markdown) ---------------------------------------
// Accepts common bank export shapes. Header row required. Recognized columns
// (case-insensitive): date, payee/description/merchant, amount, or debit+credit,
// memo/notes, category.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

function parseAmountToCents(str) {
  if (str === undefined || str === null) return null;
  let t = String(str).trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

function parseDateToISO(str) {
  const t = String(str || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US MM/DD/YYYY
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

// Parse a Markdown file into the same row-of-cells shape parseCSV produces, so
// the rest of the importer treats CSV and Markdown identically. Supports GitHub
// pipe tables (the natural way to write a statement in Markdown):
//   | Date       | Description | Amount  |
//   |------------|-------------|---------|
//   | 2026-06-01 | Kroger      | -45.67  |
// Non-table prose above/below the table is ignored.
function parseMarkdown(text) {
  const lines = String(text).split(/\r?\n/);
  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = l => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && /-/.test(l);
  const splitRow = l => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    // Split on unescaped pipes, then unescape \| .
    return s.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
  };

  const rows = [];
  for (const line of lines) {
    if (!isTableRow(line) || isSeparator(line)) continue;
    rows.push(splitRow(line));
  }
  return rows;
}

function detectFormat(content, hint) {
  if (hint === 'csv' || hint === 'md') return hint;
  const s = String(content);
  // A Markdown pipe table has header + separator rows made of pipes and dashes.
  if (/^\s*\|.*\|\s*$/m.test(s) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/m.test(s)) return 'md';
  return 'csv';
}

// Turn parsed rows into the exact transactions we intend to create — WITHOUT
// touching the database's transaction table. Returns { candidates, errors }.
// Each candidate carries everything needed both to show the AI auditor and to
// insert on approval (date, payee, signed amount_cents, memo, resolved category,
// dedupe hash, and source row number).
function buildCandidates(db, accountId, rows) {
  if (rows.length < 2) throw httpError(400, 'file needs a header row and at least one data row');

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const col = (...names) => header.findIndex(h => names.includes(h));
  const iDate = col('date', 'transaction date', 'posted date');
  const iPayee = col('payee', 'description', 'merchant', 'name');
  const iAmount = col('amount');
  const iDebit = col('debit', 'withdrawal', 'outflow');
  const iCredit = col('credit', 'deposit', 'inflow');
  const iMemo = col('memo', 'notes', 'note');
  const iCategory = col('category');
  if (iDate < 0 || iPayee < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) {
    throw httpError(400, 'file must have date, payee/description, and amount (or debit/credit) columns');
  }

  const incomeId = incomeCategoryId(db);
  const catByName = new Map(
    db.prepare('SELECT id, name FROM categories WHERE is_income = 0 AND payment_account_id IS NULL').all()
      .map(c => [c.name.toLowerCase(), c.id])
  );

  const candidates = [];
  const errors = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const date = parseDateToISO(cells[iDate]);
    const payee = String(cells[iPayee] || '').trim();
    let amount = null;
    if (iAmount >= 0) amount = parseAmountToCents(cells[iAmount]);
    if (amount === null && iDebit >= 0) {
      const d = parseAmountToCents(cells[iDebit]);
      if (d !== null && d !== 0) amount = -Math.abs(d);
    }
    if (amount === null && iCredit >= 0) {
      const c = parseAmountToCents(cells[iCredit]);
      if (c !== null && c !== 0) amount = Math.abs(c);
    }
    if (!date || amount === null) { errors.push(`row ${r + 1}: bad date or amount`); continue; }

    let categoryId = null, autoCategorized = false;
    if (iCategory >= 0 && cells[iCategory]) {
      const name = String(cells[iCategory]).trim().toLowerCase();
      if (name === 'income') categoryId = incomeId;
      else categoryId = catByName.get(name) ?? null;
    }
    if (!categoryId && amount > 0) categoryId = incomeId; // inflows default to income
    if (!categoryId && payee) {
      categoryId = suggestCategory(db, payee);
      if (categoryId) autoCategorized = true;
    }
    const memo = iMemo >= 0 ? String(cells[iMemo] || '').trim() : '';
    const hash = crypto.createHash('sha256')
      .update(`${accountId}|${date}|${payee}|${amount}`).digest('hex');
    candidates.push({ row: r + 1, date, payee, amount_cents: amount, memo, category_id: categoryId, autoCategorized, hash });
  }
  return { candidates, errors };
}

// Write approved candidates, skipping import-hash duplicates.
function insertCandidates(db, accountId, candidates) {
  let imported = 0, skipped = 0, autoCategorized = 0;
  const ins = db.prepare(`
    INSERT INTO transactions (account_id, date, payee, category_id, amount_cents, memo, import_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const dupCheck = db.prepare('SELECT id FROM transactions WHERE import_hash = ?');
  for (const c of candidates) {
    if (dupCheck.get(c.hash)) { skipped++; continue; }
    ins.run(accountId, c.date, c.payee, c.category_id, c.amount_cents, c.memo, c.hash);
    imported++;
    if (c.autoCategorized) autoCategorized++;
  }
  return { imported, skipped_duplicates: skipped, auto_categorized: autoCategorized };
}

// Mandatory-AI-gated import for CSV or Markdown. Parses the file into the exact
// transactions it would create, hands the raw file + those transactions to the
// AI auditor (verifyImport), and only writes them if the auditor confirms they
// faithfully match the file. A failed or unavailable auditor aborts the import
// so nothing is written on unverified data.
async function importFile(db, accountId, content, opts = {}) {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw httpError(400, 'unknown account_id');
  if (!content || !String(content).trim()) throw httpError(400, 'file is empty');
  if (typeof opts.verifyImport !== 'function') {
    throw httpError(503, 'AI import auditor is not configured; import is disabled without it');
  }

  const format = detectFormat(content, opts.format);
  const rows = format === 'md' ? parseMarkdown(content) : parseCSV(content);
  const { candidates, errors } = buildCandidates(db, accountId, rows);
  if (candidates.length === 0) {
    throw httpError(400, 'no valid transactions found in file', { errors });
  }

  // --- mandatory verification gate ---
  const verification = await opts.verifyImport({ rawContent: String(content), format, candidates });
  if (!verification || verification.verified !== true) {
    throw httpError(422, 'AI auditor could not verify the transactions match the file — nothing was imported', {
      verification: verification || null,
      parse_errors: errors,
    });
  }

  const result = insertCandidates(db, accountId, candidates);
  return { format, ...result, errors, verification };
}

// Lower-level, synchronous parse+insert with NO AI gate. Not exposed through
// the HTTP API (which always routes CSV/Markdown through the AI-audited
// importFile); kept for the parser/dedupe unit tests and programmatic seeding.
function importCSV(db, accountId, csvText) {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw httpError(400, 'unknown account_id');
  const { candidates, errors } = buildCandidates(db, accountId, parseCSV(csvText));
  return { ...insertCandidates(db, accountId, candidates), errors };
}

module.exports = {
  createTransaction, updateTransaction, deleteTransaction, getTransaction,
  listTransactions, importFile, importCSV, buildCandidates, insertCandidates,
  parseCSV, parseMarkdown, detectFormat, parseAmountToCents, parseDateToISO, httpError,
};

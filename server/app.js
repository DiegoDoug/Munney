'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, incomeCategoryId } = require('./db');
const budget = require('./budget');
const reports = require('./reports');
const { detectRecurring } = require('./recurring');
const tx = require('./transactions');
const { httpError } = tx;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createApp({ dbPath = ':memory:' } = {}) {
  const db = open(dbPath);
  const publicDir = path.join(__dirname, '..', 'public');

  // --- route table: [method, regex, handler(req, params, query, body)] ----
  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler });
  };

  const today = () => new Date().toISOString().slice(0, 10);
  const validMonth = m => /^\d{4}-\d{2}$/.test(m);
  const monthOr = (q, fallback) => (q.month && validMonth(q.month) ? q.month : fallback);

  // Accounts
  route('GET', '/api/accounts', () => ({ accounts: budget.accountBalances(db) }));

  route('POST', '/api/accounts', (req, p, q, body) => {
    const { name, type = 'checking', on_budget } = body;
    if (!name || !String(name).trim()) throw httpError(400, 'name is required');
    const types = ['checking', 'savings', 'cash', 'credit', 'investment', 'loan'];
    if (!types.includes(type)) throw httpError(400, `type must be one of ${types.join(', ')}`);
    const onBudget = on_budget !== undefined ? (on_budget ? 1 : 0)
      : (['checking', 'savings', 'cash', 'credit'].includes(type) ? 1 : 0);
    const r = db.prepare('INSERT INTO accounts (name, type, on_budget) VALUES (?, ?, ?)')
      .run(String(name).trim(), type, onBudget);
    const id = r.lastInsertRowid;
    const opening = Math.trunc(Number(body.balance_cents || 0));
    if (opening !== 0) {
      // Positive opening balances in on-budget asset accounts are new money => income.
      // Credit/loan/off-budget opening balances are just pre-existing position.
      const isAsset = onBudget === 1 && opening > 0 && type !== 'credit';
      db.prepare(`
        INSERT INTO transactions (account_id, date, payee, category_id, amount_cents, memo)
        VALUES (?, ?, 'Starting Balance', ?, ?, '')
      `).run(id, body.balance_date || today(), isAsset ? incomeCategoryId(db) : null, opening);
    }
    return { account: budget.accountBalances(db).find(a => a.id === id) };
  });

  route('PATCH', '/api/accounts/:id', (req, p, q, body) => {
    const id = Number(p.id);
    const acct = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
    if (!acct) throw httpError(404, 'account not found');
    if (body.name !== undefined) db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(String(body.name).trim(), id);
    if (body.closed !== undefined) db.prepare('UPDATE accounts SET closed = ? WHERE id = ?').run(body.closed ? 1 : 0, id);
    return { account: budget.accountBalances(db).find(a => a.id === id) };
  });

  route('DELETE', '/api/accounts/:id', (req, p) => {
    const r = db.prepare('DELETE FROM accounts WHERE id = ?').run(Number(p.id));
    if (r.changes === 0) throw httpError(404, 'account not found');
    return { ok: true };
  });

  // Categories
  route('GET', '/api/categories', () => {
    const groups = db.prepare('SELECT id, name, sort_order FROM category_groups WHERE is_system = 0 ORDER BY sort_order, id').all();
    const cats = db.prepare('SELECT id, group_id, name, hidden, target_cents FROM categories WHERE is_income = 0 ORDER BY sort_order, id').all();
    return {
      income_category_id: incomeCategoryId(db),
      groups: groups.map(g => ({ ...g, categories: cats.filter(c => c.group_id === g.id) })),
    };
  });

  route('POST', '/api/category-groups', (req, p, q, body) => {
    if (!body.name || !String(body.name).trim()) throw httpError(400, 'name is required');
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM category_groups WHERE is_system = 0').get().m;
    const r = db.prepare('INSERT INTO category_groups (name, sort_order) VALUES (?, ?)').run(String(body.name).trim(), max + 1);
    return { id: r.lastInsertRowid, name: String(body.name).trim() };
  });

  route('POST', '/api/categories', (req, p, q, body) => {
    const { group_id, name } = body;
    const g = db.prepare('SELECT id FROM category_groups WHERE id = ? AND is_system = 0').get(Number(group_id));
    if (!g) throw httpError(400, 'unknown group_id');
    if (!name || !String(name).trim()) throw httpError(400, 'name is required');
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE group_id = ?').get(g.id).m;
    const r = db.prepare('INSERT INTO categories (group_id, name, sort_order, target_cents) VALUES (?, ?, ?, ?)')
      .run(g.id, String(name).trim(), max + 1, body.target_cents != null ? Math.trunc(Number(body.target_cents)) : null);
    return { id: r.lastInsertRowid };
  });

  route('PATCH', '/api/categories/:id', (req, p, q, body) => {
    const id = Number(p.id);
    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND is_income = 0').get(id);
    if (!cat) throw httpError(404, 'category not found');
    if (body.name !== undefined) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(String(body.name).trim(), id);
    if (body.hidden !== undefined) db.prepare('UPDATE categories SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, id);
    if (body.target_cents !== undefined) {
      db.prepare('UPDATE categories SET target_cents = ? WHERE id = ?')
        .run(body.target_cents === null ? null : Math.trunc(Number(body.target_cents)), id);
    }
    return { ok: true };
  });

  route('DELETE', '/api/categories/:id', (req, p) => {
    const id = Number(p.id);
    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND is_income = 0').get(id);
    if (!cat) throw httpError(404, 'category not found');
    db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return { ok: true };
  });

  // Transactions
  route('GET', '/api/transactions', (req, p, q) => tx.listTransactions(db, q));
  route('POST', '/api/transactions', (req, p, q, body) => ({ transaction: tx.createTransaction(db, body) }));
  route('PATCH', '/api/transactions/:id', (req, p, q, body) => ({ transaction: tx.updateTransaction(db, Number(p.id), body) }));
  route('DELETE', '/api/transactions/:id', (req, p) => { tx.deleteTransaction(db, Number(p.id)); return { ok: true }; });
  route('POST', '/api/transactions/import', (req, p, q, body) => {
    if (!body.csv) throw httpError(400, 'csv is required');
    return tx.importCSV(db, Number(body.account_id), body.csv);
  });

  // Budget
  route('GET', '/api/budget/:month', (req, p) => {
    if (!validMonth(p.month)) throw httpError(400, 'month must be YYYY-MM');
    return budget.budgetForMonth(db, p.month);
  });
  route('PUT', '/api/budget/:month/:categoryId', (req, p, q, body) => {
    if (!validMonth(p.month)) throw httpError(400, 'month must be YYYY-MM');
    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND is_income = 0').get(Number(p.categoryId));
    if (!cat) throw httpError(400, 'unknown category');
    const cents = Math.trunc(Number(body.assigned_cents));
    if (!Number.isFinite(cents)) throw httpError(400, 'assigned_cents must be an integer');
    budget.setAssigned(db, p.month, cat.id, cents);
    return budget.budgetForMonth(db, p.month);
  });

  // Recurring
  route('GET', '/api/recurring', () => {
    const series = detectRecurring(db, today());
    const active = series.filter(s => s.active);
    return {
      series,
      total_monthly_cost_cents: active.reduce((sum, s) => sum + s.monthly_cost_cents, 0),
    };
  });

  // Reports
  route('GET', '/api/reports/spending', (req, p, q) =>
    ({ month: monthOr(q, budget.currentMonth()), categories: reports.spendingByCategory(db, monthOr(q, budget.currentMonth())) }));
  route('GET', '/api/reports/cashflow', (req, p, q) =>
    ({ months: reports.cashflow(db, Math.min(Number(q.months) || 12, 60), monthOr(q, undefined)) }));
  route('GET', '/api/reports/networth', (req, p, q) =>
    ({ months: reports.netWorthSeries(db, Math.min(Number(q.months) || 12, 60), monthOr(q, undefined)) }));

  // Dashboard (Copilot-style overview)
  route('GET', '/api/dashboard', (req, p, q) => {
    const month = monthOr(q, budget.currentMonth());
    const flow = reports.cashflow(db, 1, month)[0];
    const b = budget.budgetForMonth(db, month);
    const topCategories = reports.spendingByCategory(db, month).slice(0, 6).map(c => {
      const cat = b.groups.flatMap(g => g.categories).find(x => x.id === c.category_id);
      return { ...c, assigned_cents: cat ? cat.assigned_cents : 0, available_cents: cat ? cat.available_cents : 0 };
    });
    const netWorth = reports.netWorthSeries(db, 12, month);
    const recurring = detectRecurring(db, today()).filter(s => s.active).slice(0, 5);
    const recent = tx.listTransactions(db, { limit: 8 }).transactions;
    return {
      month,
      income_cents: flow.income_cents,
      spent_cents: flow.spent_cents,
      net_cents: flow.net_cents,
      ready_to_assign: b.ready_to_assign,
      total_assigned_cents: b.total_assigned_cents,
      net_worth_cents: netWorth[netWorth.length - 1].net_worth_cents,
      net_worth_series: netWorth,
      top_categories: topCategories,
      upcoming_recurring: recurring,
      recent_transactions: recent,
    };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
          const query = Object.fromEntries(url.searchParams);
          let body = {};
          if (req.method !== 'GET' && req.method !== 'DELETE') {
            const chunks = [];
            for await (const c of req) {
              chunks.push(c);
              if (Buffer.concat(chunks).length > 10 * 1024 * 1024) throw httpError(413, 'body too large');
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw) {
              try { body = JSON.parse(raw); } catch { throw httpError(400, 'invalid JSON body'); }
            }
          }
          return send(200, r.handler(req, params, query, body));
        }
        return send(404, { error: 'not found' });
      }

      // Static files
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      const full = path.join(publicDir, path.normalize(file));
      if (!full.startsWith(publicDir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        // SPA fallback for hash-less paths
        const index = path.join(publicDir, 'index.html');
        if (fs.existsSync(index)) {
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          return res.end(fs.readFileSync(index));
        }
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(fs.readFileSync(full));
    } catch (e) {
      send(e.status || 500, { error: e.message });
      if (!e.status) console.error(e);
    }
  });

  server.db = db;
  return server;
}

module.exports = { createApp };

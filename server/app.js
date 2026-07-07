'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, incomeCategoryId, ensurePaymentCategory, resetData } = require('./db');
const budget = require('./budget');
const reports = require('./reports');
const { ageOfMoney } = require('./aom');
const { detectRecurring } = require('./recurring');
const tx = require('./transactions');
const agent = require('./agent');
const { httpError } = tx;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createApp({ dbPath = ':memory:', verifyImport } = {}) {
  const db = open(dbPath);
  const publicDir = path.join(__dirname, '..', 'public');
  // The mandatory AI import auditor. Defaults to the real DeepSeek verifier;
  // tests inject a stub. When no key is configured this stays undefined and the
  // import endpoint refuses to run rather than importing unverified data.
  const importVerifier = verifyImport ?? (agent.isConfigured() ? agent.verifyImport : undefined);

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
    if (type === 'credit') ensurePaymentCategory(db, id, String(name).trim());
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
    const acct = db.prepare('SELECT id, type FROM accounts WHERE id = ?').get(id);
    if (!acct) throw httpError(404, 'account not found');
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw httpError(400, 'name cannot be empty');
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id);
      db.prepare('UPDATE categories SET name = ? WHERE payment_account_id = ?').run(name, id);
    }
    if (body.type !== undefined && body.type !== acct.type) {
      const types = ['checking', 'savings', 'cash', 'credit', 'investment', 'loan'];
      if (!types.includes(body.type)) throw httpError(400, `type must be one of ${types.join(', ')}`);
      db.prepare('UPDATE accounts SET type = ? WHERE id = ?').run(body.type, id);
      // Keep the credit-card payment category in sync with the account's type.
      if (body.type === 'credit') {
        const name = db.prepare('SELECT name FROM accounts WHERE id = ?').get(id).name;
        ensurePaymentCategory(db, id, name);
      } else {
        db.prepare('DELETE FROM categories WHERE payment_account_id = ?').run(id);
      }
    }
    if (body.on_budget !== undefined) db.prepare('UPDATE accounts SET on_budget = ? WHERE id = ?').run(body.on_budget ? 1 : 0, id);
    if (body.closed !== undefined) db.prepare('UPDATE accounts SET closed = ? WHERE id = ?').run(body.closed ? 1 : 0, id);
    return { account: budget.accountBalances(db).find(a => a.id === id) };
  });

  route('DELETE', '/api/accounts/:id', (req, p) => {
    db.prepare('DELETE FROM categories WHERE payment_account_id = ?').run(Number(p.id));
    const r = db.prepare('DELETE FROM accounts WHERE id = ?').run(Number(p.id));
    if (r.changes === 0) throw httpError(404, 'account not found');
    return { ok: true };
  });

  // Categories
  // Transaction-facing category list: excludes credit card payment categories
  // (money moves into those automatically; you never categorize spending to them).
  route('GET', '/api/categories', () => {
    const groups = db.prepare('SELECT id, name, sort_order FROM category_groups WHERE is_system = 0 ORDER BY sort_order, id').all();
    const cats = db.prepare('SELECT id, group_id, name, hidden, target_cents, target_type, target_date FROM categories WHERE is_income = 0 AND payment_account_id IS NULL ORDER BY sort_order, id').all();
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

  // Guard: only user groups (is_system = 0) may be renamed/deleted/reordered.
  const userGroupOr404 = id => {
    const g = db.prepare('SELECT id FROM category_groups WHERE id = ? AND is_system = 0').get(Number(id));
    if (!g) throw httpError(404, 'category group not found');
    return g;
  };

  route('PATCH', '/api/category-groups/:id', (req, p, q, body) => {
    userGroupOr404(p.id);
    if (body.name !== undefined) {
      if (!String(body.name).trim()) throw httpError(400, 'name is required');
      db.prepare('UPDATE category_groups SET name = ? WHERE id = ?').run(String(body.name).trim(), Number(p.id));
    }
    return { ok: true };
  });

  route('DELETE', '/api/category-groups/:id', (req, p) => {
    userGroupOr404(p.id);
    // Detach transactions from every category in the group, then cascade-delete.
    const cats = db.prepare('SELECT id FROM categories WHERE group_id = ?').all(Number(p.id));
    for (const c of cats) db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(c.id);
    db.prepare('DELETE FROM category_groups WHERE id = ?').run(Number(p.id));
    return { ok: true };
  });

  // Reorder groups: body.ids is the full ordered list of user-group ids.
  route('POST', '/api/category-groups/reorder', (req, p, q, body) => {
    if (!Array.isArray(body.ids)) throw httpError(400, 'ids must be an array');
    let order = 0;
    for (const id of body.ids) {
      db.prepare('UPDATE category_groups SET sort_order = ? WHERE id = ? AND is_system = 0').run(order++, Number(id));
    }
    return { ok: true };
  });

  route('POST', '/api/categories', (req, p, q, body) => {
    const { group_id, name } = body;
    const g = db.prepare('SELECT id FROM category_groups WHERE id = ? AND is_system = 0').get(Number(group_id));
    if (!g) throw httpError(400, 'unknown group_id');
    if (!name || !String(name).trim()) throw httpError(400, 'name is required');
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE group_id = ?').get(g.id).m;
    const target = parseTarget(body);
    const r = db.prepare('INSERT INTO categories (group_id, name, sort_order, target_cents, target_type, target_date) VALUES (?, ?, ?, ?, ?, ?)')
      .run(g.id, String(name).trim(), max + 1, target.cents, target.type, target.date);
    return { id: r.lastInsertRowid };
  });

  // Normalizes {target_cents, target_type, target_date} from a request body.
  function parseTarget(body) {
    const cents = body.target_cents != null ? Math.trunc(Number(body.target_cents)) : null;
    if (body.target_cents != null && !Number.isFinite(cents)) throw httpError(400, 'target_cents must be an integer');
    let type = body.target_type || 'monthly';
    if (!['monthly', 'by_date'].includes(type)) throw httpError(400, "target_type must be 'monthly' or 'by_date'");
    let date = body.target_date ?? null;
    if (type === 'by_date') {
      if (!validMonth(date)) throw httpError(400, 'target_date must be YYYY-MM for by_date targets');
    } else date = null;
    if (cents === null) type = 'monthly';
    return { cents, type, date: type === 'by_date' ? date : null };
  }

  route('PATCH', '/api/categories/:id', (req, p, q, body) => {
    const id = Number(p.id);
    const cat = db.prepare('SELECT id, payment_account_id FROM categories WHERE id = ? AND is_income = 0').get(id);
    if (!cat) throw httpError(404, 'category not found');
    if (body.name !== undefined) {
      if (!String(body.name).trim()) throw httpError(400, 'name is required');
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(String(body.name).trim(), id);
    }
    if (body.hidden !== undefined) db.prepare('UPDATE categories SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, id);
    if (body.group_id !== undefined) {
      if (cat.payment_account_id) throw httpError(400, 'credit card payment categories cannot be moved');
      const g = db.prepare('SELECT id FROM category_groups WHERE id = ? AND is_system = 0').get(Number(body.group_id));
      if (!g) throw httpError(400, 'unknown group_id');
      const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE group_id = ?').get(g.id).m;
      db.prepare('UPDATE categories SET group_id = ?, sort_order = ? WHERE id = ?').run(g.id, max + 1, id);
    }
    if (body.target_cents !== undefined || body.target_type !== undefined || body.target_date !== undefined) {
      const current = db.prepare('SELECT target_cents, target_type, target_date FROM categories WHERE id = ?').get(id);
      const target = parseTarget({
        target_cents: body.target_cents !== undefined ? body.target_cents : current.target_cents,
        target_type: body.target_type !== undefined ? body.target_type : current.target_type,
        target_date: body.target_date !== undefined ? body.target_date : current.target_date,
      });
      db.prepare('UPDATE categories SET target_cents = ?, target_type = ?, target_date = ? WHERE id = ?')
        .run(target.cents, target.type, target.date, id);
    }
    return { ok: true };
  });

  route('DELETE', '/api/categories/:id', (req, p) => {
    const id = Number(p.id);
    const cat = db.prepare('SELECT id, payment_account_id FROM categories WHERE id = ? AND is_income = 0').get(id);
    if (!cat) throw httpError(404, 'category not found');
    if (cat.payment_account_id) throw httpError(400, 'credit card payment categories are managed automatically — delete the account instead');
    db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return { ok: true };
  });

  // Reorder categories within a group: body.ids is the full ordered id list.
  route('POST', '/api/categories/reorder', (req, p, q, body) => {
    if (!Array.isArray(body.ids)) throw httpError(400, 'ids must be an array');
    let order = 0;
    for (const id of body.ids) {
      db.prepare('UPDATE categories SET sort_order = ? WHERE id = ? AND is_income = 0').run(order++, Number(id));
    }
    return { ok: true };
  });

  // Auto-categorization rules (learned payee -> category). Fully user-manageable.
  route('GET', '/api/payee-rules', () => ({
    rules: db.prepare(`
      SELECT r.payee_norm, r.category_id, c.name AS category_name, r.updated_at
      FROM payee_rules r JOIN categories c ON c.id = r.category_id
      ORDER BY r.payee_norm
    `).all(),
  }));

  route('PUT', '/api/payee-rules/:payee', (req, p, q, body) => {
    const norm = String(p.payee).trim().toLowerCase();
    if (!norm) throw httpError(400, 'payee is required');
    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND is_income = 0 AND payment_account_id IS NULL').get(Number(body.category_id));
    if (!cat) throw httpError(400, 'unknown category_id');
    db.prepare(`
      INSERT INTO payee_rules (payee_norm, category_id, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT (payee_norm) DO UPDATE SET category_id = excluded.category_id, updated_at = datetime('now')
    `).run(norm, cat.id);
    return { ok: true };
  });

  route('DELETE', '/api/payee-rules/:payee', (req, p) => {
    const r = db.prepare('DELETE FROM payee_rules WHERE payee_norm = ?').run(String(p.payee).trim().toLowerCase());
    if (r.changes === 0) throw httpError(404, 'rule not found');
    return { ok: true };
  });

  // Danger zone: wipe all user data back to a fresh install.
  route('POST', '/api/reset', (req, p, q, body) => {
    resetData(db, { keepStarterCategories: body.keep_starter_categories !== false });
    return { ok: true };
  });

  // Transactions
  route('GET', '/api/transactions', (req, p, q) => tx.listTransactions(db, q));
  route('POST', '/api/transactions', (req, p, q, body) => ({ transaction: tx.createTransaction(db, body) }));
  route('PATCH', '/api/transactions/:id', (req, p, q, body) => ({ transaction: tx.updateTransaction(db, Number(p.id), body) }));
  route('DELETE', '/api/transactions/:id', (req, p) => { tx.deleteTransaction(db, Number(p.id)); return { ok: true }; });
  // AI-audited CSV/Markdown import. Accepts { content } (or legacy { csv }),
  // optional { format: 'csv'|'md' }. Every import is verified by the mandatory
  // AI auditor before any transaction is written.
  route('POST', '/api/transactions/import', async (req, p, q, body) => {
    const content = body.content ?? body.csv;
    if (!content) throw httpError(400, 'content is required (CSV or Markdown text)');
    if (!importVerifier) {
      throw httpError(503, 'AI import auditor is not configured: set DEEPSEEK_API_KEY in .env to enable importing');
    }
    return tx.importFile(db, Number(body.account_id), content, {
      format: body.format,
      verifyImport: importVerifier,
    });
  });

  // Whether AI-audited import is available (drives the UI's import affordance).
  route('GET', '/api/import/status', () => ({ ai_available: Boolean(importVerifier), model: agent.config().model }));

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
    const aom = ageOfMoney(db, today());
    return {
      month,
      age_of_money: aom,
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
          return send(200, await r.handler(req, params, query, body));
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
      send(e.status || 500, { error: e.message, ...(e.data ? { details: e.data } : {}) });
      if (!e.status) console.error(e);
    }
  });

  server.db = db;
  return server;
}

module.exports = { createApp };

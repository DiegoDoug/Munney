'use strict';
const { monthEnd, prevMonth, currentMonth } = require('./budget');

function lastNMonths(n, endMonth) {
  const months = [];
  let m = endMonth || currentMonth();
  for (let i = 0; i < n; i++) { months.unshift(m); m = prevMonth(m); }
  return months;
}

// Spending by category for one month (on-budget, excludes income & transfers).
function spendingByCategory(db, month) {
  return db.prepare(`
    SELECT c.id AS category_id, c.name AS category, g.name AS "group",
           -SUM(t.amount_cents) AS spent_cents
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN categories c ON c.id = t.category_id
    JOIN category_groups g ON g.id = c.group_id
    WHERE a.on_budget = 1 AND c.is_income = 0 AND t.transfer_pair_id IS NULL
      AND substr(t.date, 1, 7) = ?
    GROUP BY c.id
    HAVING spent_cents > 0
    ORDER BY spent_cents DESC
  `).all(month);
}

// Income vs spending per month for the last n months.
function cashflow(db, n, endMonth) {
  const months = lastNMonths(n, endMonth);
  const rows = db.prepare(`
    SELECT substr(t.date, 1, 7) AS month,
           SUM(CASE WHEN c.is_income = 1 THEN t.amount_cents ELSE 0 END) AS income_cents,
           SUM(CASE WHEN c.is_income = 0 AND t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS spent_cents
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.on_budget = 1 AND t.transfer_pair_id IS NULL AND substr(t.date, 1, 7) >= ?
    GROUP BY month
  `).all(months[0]);
  const byMonth = new Map(rows.map(r => [r.month, r]));
  return months.map(m => {
    const r = byMonth.get(m) || { income_cents: 0, spent_cents: 0 };
    return { month: m, income_cents: r.income_cents, spent_cents: r.spent_cents, net_cents: r.income_cents - r.spent_cents };
  });
}

// Month-end net worth series across ALL accounts (assets minus debts).
function netWorthSeries(db, n, endMonth) {
  const months = lastNMonths(n, endMonth);
  const stmt = db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE date <= ?'
  );
  return months.map(m => ({ month: m, net_worth_cents: stmt.get(monthEnd(m)).s }));
}

module.exports = { spendingByCategory, cashflow, netWorthSeries, lastNMonths };

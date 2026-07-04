'use strict';
// The YNAB-style envelope engine. All amounts are integer cents.
// Sign convention: outflows negative, inflows positive.
// Envelope balances (Available) roll over month to month, including negatives,
// which keeps the invariant: RTA + sum(Available) == total funds in on-budget accounts.

function monthEnd(month) {
  return month + '-31'; // safe upper bound for lexicographic YYYY-MM-DD comparison
}

function prevMonth(month) {
  let [y, m] = month.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function nextMonth(month) {
  let [y, m] = month.split('-').map(Number);
  m += 1;
  if (m === 13) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

// Full budget view for one month: groups -> categories with assigned/activity/available.
function budgetForMonth(db, month) {
  const end = monthEnd(month);

  // Per-category running totals through end of month + this month's slice.
  const assignedRows = db.prepare(`
    SELECT category_id,
           SUM(assigned_cents) AS through,
           SUM(CASE WHEN month = ? THEN assigned_cents ELSE 0 END) AS in_month
    FROM budget_allocations WHERE month <= ? GROUP BY category_id
  `).all(month, month);

  const activityRows = db.prepare(`
    SELECT t.category_id,
           SUM(t.amount_cents) AS through,
           SUM(CASE WHEN substr(t.date, 1, 7) = ? THEN t.amount_cents ELSE 0 END) AS in_month
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE a.on_budget = 1 AND t.category_id IS NOT NULL AND t.date <= ?
    GROUP BY t.category_id
  `).all(month, end);

  const assigned = new Map(assignedRows.map(r => [r.category_id, r]));
  const activity = new Map(activityRows.map(r => [r.category_id, r]));

  // Credit card payment categories: budgeted spending on the card moves money
  // into the payment category; transfers to the card (payments) draw it down.
  // Contribution of a card transaction = -amount, over categorized non-income
  // transactions and transfer legs (starting balances / uncategorized excluded).
  const ccRows = db.prepare(`
    SELECT c.id AS category_id,
           -SUM(t.amount_cents) AS through,
           -SUM(CASE WHEN substr(t.date, 1, 7) = ? THEN t.amount_cents ELSE 0 END) AS in_month
    FROM categories c
    JOIN transactions t ON t.account_id = c.payment_account_id
    LEFT JOIN categories tc ON tc.id = t.category_id
    WHERE c.payment_account_id IS NOT NULL AND t.date <= ?
      AND (t.transfer_pair_id IS NOT NULL OR (t.category_id IS NOT NULL AND tc.is_income = 0))
    GROUP BY c.id
  `).all(month, end);
  for (const r of ccRows) activity.set(r.category_id, r);

  const groups = db.prepare(
    'SELECT id, name, sort_order, is_system FROM category_groups WHERE is_system != 1 ORDER BY sort_order, id'
  ).all();
  const cats = db.prepare(
    'SELECT id, group_id, name, sort_order, hidden, target_cents, target_type, target_date, payment_account_id FROM categories WHERE is_income = 0 ORDER BY sort_order, id'
  ).all();

  let totalAssigned = 0, totalActivity = 0, totalAvailable = 0;
  const byGroup = new Map(groups.map(g => [g.id, { ...g, is_cc: g.is_system === 2, categories: [] }]));
  for (const c of cats) {
    const a = assigned.get(c.id) || { through: 0, in_month: 0 };
    const act = activity.get(c.id) || { through: 0, in_month: 0 };
    const row = {
      id: c.id,
      group_id: c.group_id,
      name: c.name,
      hidden: !!c.hidden,
      payment_account_id: c.payment_account_id,
      target_cents: c.target_cents,
      target_type: c.target_type || 'monthly',
      target_date: c.target_date,
      assigned_cents: a.in_month || 0,
      activity_cents: act.in_month || 0,
      available_cents: (a.through || 0) + (act.through || 0),
    };
    row.goal = goalStatus(row, month);
    totalAssigned += row.assigned_cents;
    totalActivity += row.activity_cents;
    totalAvailable += row.available_cents;
    const g = byGroup.get(c.group_id);
    if (g) g.categories.push(row);
  }

  return {
    month,
    ready_to_assign: readyToAssign(db, month),
    total_assigned_cents: totalAssigned,
    total_activity_cents: totalActivity,
    total_available_cents: totalAvailable,
    groups: [...byGroup.values()],
  };
}

// Goal progress for a category row in a given month.
// 'monthly' (YNAB "Monthly Savings Builder"): assign target_cents every month.
// 'by_date' (YNAB "Savings Balance by Date"): grow Available to target_cents by
// target_date; the needed-per-month suggestion spreads the remainder evenly
// over the months left (including the viewed month).
function goalStatus(row, month) {
  if (!row.target_cents) return null;
  if (row.target_type === 'by_date' && row.target_date) {
    const [y, m] = month.split('-').map(Number);
    const [ty, tm] = row.target_date.split('-').map(Number);
    const monthsLeft = Math.max(1, (ty - y) * 12 + (tm - m) + 1); // overdue counts as "due now"
    const overdue = (ty - y) * 12 + (tm - m) < 0;
    const remaining = Math.max(0, row.target_cents - (row.available_cents - row.assigned_cents));
    const needed = Math.ceil(remaining / monthsLeft);
    const funded = row.available_cents >= row.target_cents;
    return {
      type: 'by_date',
      target_date: row.target_date,
      months_left: monthsLeft,
      needed_per_month_cents: needed,
      status: funded ? 'funded' : overdue ? 'overdue' : row.assigned_cents >= needed ? 'on_track' : 'behind',
    };
  }
  return {
    type: 'monthly',
    needed_per_month_cents: row.target_cents,
    status: row.assigned_cents >= row.target_cents ? 'funded' : 'behind',
  };
}

// RTA(m) = all income received through m, minus everything assigned through m.
function readyToAssign(db, month) {
  const end = monthEnd(month);
  const income = db.prepare(`
    SELECT COALESCE(SUM(t.amount_cents), 0) AS s
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN categories c ON c.id = t.category_id
    WHERE a.on_budget = 1 AND c.is_income = 1 AND t.date <= ?
  `).get(end).s;
  const assigned = db.prepare(
    'SELECT COALESCE(SUM(assigned_cents), 0) AS s FROM budget_allocations WHERE month <= ?'
  ).get(month).s;
  return income - assigned;
}

function setAssigned(db, month, categoryId, cents) {
  db.prepare(`
    INSERT INTO budget_allocations (month, category_id, assigned_cents) VALUES (?, ?, ?)
    ON CONFLICT (month, category_id) DO UPDATE SET assigned_cents = excluded.assigned_cents
  `).run(month, categoryId, cents);
}

function accountBalances(db) {
  return db.prepare(`
    SELECT a.id, a.name, a.type, a.on_budget, a.closed,
           COALESCE(SUM(t.amount_cents), 0) AS balance_cents,
           COALESCE(SUM(CASE WHEN t.cleared = 1 THEN t.amount_cents ELSE 0 END), 0) AS cleared_cents
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id
    ORDER BY a.closed, a.on_budget DESC, a.id
  `).all();
}

module.exports = {
  budgetForMonth, readyToAssign, setAssigned, accountBalances,
  monthEnd, prevMonth, nextMonth, currentMonth,
};

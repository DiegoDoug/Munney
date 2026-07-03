'use strict';
// Copilot-style recurring detection: find payees charged at a stable cadence
// with similar amounts, predict the next charge and estimate monthly cost.

const { normalizePayee } = require('./categorize');

const CADENCES = [
  { name: 'weekly',   min: 5,   max: 9,   perMonth: 52 / 12 },
  { name: 'biweekly', min: 12,  max: 16,  perMonth: 26 / 12 },
  { name: 'monthly',  min: 26,  max: 35,  perMonth: 1 },
  { name: 'yearly',   min: 350, max: 380, perMonth: 1 / 12 },
];

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(dateStr, months) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // clamp e.g. Jan 31 -> Feb 28
  const nd = Math.min(day, lastDay);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// txns: [{date, payee, amount_cents, category_id}] spending only (amount < 0).
function detectSeries(txns, today) {
  const groups = new Map();
  for (const t of txns) {
    if (t.amount_cents >= 0) continue;
    const key = normalizePayee(t.payee);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const series = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < list.length; i++) gaps.push(daysBetween(list[i - 1].date, list[i].date));
    const medGap = median(gaps);
    const cadence = CADENCES.find(c => medGap >= c.min && medGap <= c.max);
    if (!cadence) continue;
    // Require most gaps to fit the cadence window (tolerates one skipped/odd gap).
    const fitting = gaps.filter(g => g >= cadence.min && g <= cadence.max).length;
    if (fitting / gaps.length < 0.6) continue;
    // Amounts must be similar: median absolute deviation within 25% of median.
    const amounts = list.map(t => -t.amount_cents);
    const medAmt = median(amounts);
    if (medAmt === 0) continue;
    const deviations = amounts.map(a => Math.abs(a - medAmt));
    if (median(deviations) / medAmt > 0.25) continue;

    const last = list[list.length - 1];
    // Monthly/yearly bills recur on the same day of the month, not a fixed gap.
    const nextDate = cadence.name === 'monthly' ? addMonths(last.date, 1)
      : cadence.name === 'yearly' ? addMonths(last.date, 12)
      : addDays(last.date, medGap);
    const overdueDays = today ? daysBetween(nextDate, today) : 0;
    series.push({
      key,
      payee: last.payee,
      category_id: last.category_id ?? null,
      cadence: cadence.name,
      count: list.length,
      amount_cents: medAmt,
      monthly_cost_cents: Math.round(medAmt * cadence.perMonth),
      last_date: last.date,
      next_date: nextDate,
      active: overdueDays <= medGap, // missed more than a full cycle => likely cancelled
    });
  }
  series.sort((a, b) => b.monthly_cost_cents - a.monthly_cost_cents);
  return series;
}

function detectRecurring(db, today) {
  const txns = db.prepare(`
    SELECT t.date, t.payee, t.amount_cents, t.category_id
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.amount_cents < 0 AND t.transfer_pair_id IS NULL AND t.payee != ''
    ORDER BY t.date
  `).all();
  return detectSeries(txns, today);
}

module.exports = { detectSeries, detectRecurring, addDays, daysBetween };

'use strict';
// YNAB's "Age of Money": how old, on average, were the dollars used by your
// last 10 cash outflows. Income inflows form a FIFO queue; each outflow
// consumes the oldest dollars first, and its age is the amount-weighted
// average age of the dollars it consumed.
//
// Cash basis: outflows are spending from non-credit on-budget accounts, plus
// transfers that leave the cash pool (credit card payments, moves to
// off-budget accounts). Card swipes themselves don't age money — the payment does.

function days(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

function ageOfMoney(db, asOf, sample = 10) {
  const incomes = db.prepare(`
    SELECT t.date, t.amount_cents AS amt
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN categories c ON c.id = t.category_id
    WHERE a.on_budget = 1 AND a.type != 'credit' AND c.is_income = 1
      AND t.amount_cents > 0 AND t.date <= ?
    ORDER BY t.date, t.id
  `).all(asOf);

  const outflows = db.prepare(`
    SELECT t.date, -t.amount_cents AS amt
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN transactions p ON p.transfer_pair_id = t.transfer_pair_id AND p.id != t.id
    LEFT JOIN accounts pa ON pa.id = p.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.on_budget = 1 AND a.type != 'credit' AND t.amount_cents < 0 AND t.date <= ?
      AND COALESCE(c.is_income, 0) = 0
      AND (t.transfer_pair_id IS NULL OR pa.type = 'credit' OR pa.on_budget = 0)
    ORDER BY t.date, t.id
  `).all(asOf);

  let qi = 0, qRemaining = incomes.length ? incomes[0].amt : 0;
  const ages = [];
  for (const out of outflows) {
    let need = out.amt, weighted = 0, matched = 0;
    while (need > 0 && qi < incomes.length) {
      const take = Math.min(need, qRemaining);
      weighted += take * days(incomes[qi].date, out.date);
      matched += take;
      need -= take;
      qRemaining -= take;
      if (qRemaining === 0 && ++qi < incomes.length) qRemaining = incomes[qi].amt;
    }
    if (matched > 0) ages.push(weighted / matched);
  }
  if (!ages.length) return null;
  const recent = ages.slice(-sample);
  return {
    days: Math.round(recent.reduce((s, a) => s + a, 0) / recent.length),
    sample_size: recent.length,
  };
}

module.exports = { ageOfMoney };

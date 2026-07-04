'use strict';
// Copilot-style auto-categorization: learn normalized(payee) -> category from
// user corrections, apply to new uncategorized transactions.

function normalizePayee(payee) {
  return String(payee || '')
    .toLowerCase()
    .replace(/[#*]\s*\w*\d\w*/g, ' ')  // "Store #1234", "US*RT4567" -> reference tokens dropped
    .replace(/\b\d{3,}\b/g, ' ')       // long reference numbers
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function learnRule(db, payee, categoryId) {
  const norm = normalizePayee(payee);
  if (!norm || !categoryId) return;
  const cat = db.prepare('SELECT is_income, payment_account_id FROM categories WHERE id = ?').get(categoryId);
  if (!cat || cat.is_income || cat.payment_account_id) return; // never learn income or CC-payment rules
  db.prepare(`
    INSERT INTO payee_rules (payee_norm, category_id, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT (payee_norm) DO UPDATE SET category_id = excluded.category_id, updated_at = datetime('now')
  `).run(norm, categoryId);
}

function suggestCategory(db, payee) {
  const norm = normalizePayee(payee);
  if (!norm) return null;
  const row = db.prepare('SELECT category_id FROM payee_rules WHERE payee_norm = ?').get(norm);
  return row ? row.category_id : null;
}

module.exports = { normalizePayee, learnRule, suggestCategory };

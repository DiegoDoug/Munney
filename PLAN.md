# Munney — Plan

A local-first personal finance app that rebuilds the core of **YNAB** (zero-based envelope
budgeting) and **Copilot Money** (dashboard, auto-categorization, recurring detection,
net worth) as a single app that runs entirely on your machine. No accounts, no cloud,
no bank credentials — your data lives in a SQLite file next to the app.

## 1. Research summary

### YNAB — what makes it YNAB
YNAB is zero-based **envelope budgeting** built on four rules
([The YNAB Method](https://www.ynab.com/ynab-method), [method overview](https://support.ynab.com/en_us/the-ynab-method-an-overview-SJmiqpi6j)):

1. **Give every dollar a job** — all money in on-budget accounts flows into a
   **Ready to Assign** pool; you allocate it to categories until RTA hits zero.
2. **Embrace your true expenses** — irregular costs (insurance, gifts) get monthly
   targets so they're funded gradually.
3. **Roll with the punches** — overspend in one category? Move money from another.
   The budget is edited constantly, not set once.
4. **Age your money** — spend this month using last month's income.

Mechanically, the budget screen is a per-month grid of category groups → categories
with three numbers each: **Assigned** (what you allocated this month), **Activity**
(spending/inflows in the month), and **Available** (running envelope balance that
rolls over month to month). The header shows **Ready to Assign** = money that entered
on-budget accounts but hasn't been given a job yet.

### Copilot Money — what makes it Copilot
Copilot is a beautiful read-mostly dashboard on top of transaction feeds
([copilot.money](https://www.copilot.money/), [Forbes review](https://www.forbes.com/advisor/banking/copilot-budget-app-review/)):

- **Dashboard** with this month's income / spending / net, budget progress, recent activity.
- **AI-ish transaction categorization** that learns from your corrections.
- **Recurring detection** — finds subscriptions and regular bills from transaction
  history, shows next expected charge and monthly cost.
- **Monthly category budgets** with visual progress.
- **Net worth tracking** across all accounts with trend over time.
- **Spending trends / reports** by category and over time.

## 2. Goal

Rebuild the *core* of both as a local web app: YNAB's envelope-budget engine as the
source of truth, wrapped in a Copilot-style dashboard/reports experience. Manual +
CSV transaction entry replaces bank sync (that's the one part that can't be local).

## 3. Architecture

Zero runtime dependencies — everything ships with Node ≥ 22:

- **Storage:** SQLite via `node:sqlite`, single file `data/munney.db`.
- **Server:** plain `node:http` JSON API + static file server (`server/`).
- **Frontend:** vanilla JS single-page app with hash routing, hand-rolled SVG charts
  (`public/`).
- **Money:** integer cents everywhere; outflows negative, inflows positive.
- **Tests:** `node:test` for unit + API integration; Playwright (dev-only dep) for a
  browser end-to-end smoke test.

### Data model
- `accounts` — name, type (checking/savings/cash/credit/investment/loan), on_budget flag.
  Opening balance is a normal transaction (categorized as income for on-budget
  asset accounts, uncategorized for credit/off-budget).
- `category_groups` / `categories` — user-defined envelopes; one built-in system
  category **Inflow: Ready to Assign** marks income.
- `transactions` — account, date, payee, category, amount_cents, memo, cleared.
  Transfers are paired transactions linked by `transfer_pair_id` (no category).
- `budget_allocations` — (month, category) → assigned_cents.
- `payee_rules` — normalized payee → category, learned from user categorization.

### Budget math (YNAB engine)
- `activity(cat, m)` = sum of that category's transaction amounts in month m
  (on-budget accounts only).
- `available(cat, m)` = Σ assigned + Σ activity over all months ≤ m — envelopes roll
  over, including negatives (simplification vs. YNAB, same invariant).
- `RTA(m)` = Σ income through m − Σ assigned through m.
- Invariant: RTA + Σ available = total funds in on-budget accounts (checked in tests).

### Copilot layer
- **Auto-categorization:** learn `normalized(payee) → category` whenever the user sets
  a category; apply on new/imported uncategorized transactions.
- **Recurring detection:** group spending by normalized payee; ≥ 2 charges with a
  stable gap (weekly/biweekly/monthly/yearly buckets) and similar amounts ⇒ a series
  with predicted next date + amount, and an estimated monthly cost rollup.
- **Net worth:** month-end balance series across all accounts.
- **Reports:** spending by category (month), 12-month income vs. spending, net worth line.

## 4. Feature checklist (v1 scope)

- [x] Accounts: create/edit/close, balances, on/off budget, account register view
- [x] Transactions: add/edit/delete, transfers, search/filter, CSV import with dedupe
- [x] Auto-categorization with learning from corrections
- [x] Budget: month grid (Assigned/Activity/Available), Ready to Assign, move money,
      monthly targets with progress
- [x] Recurring: detected series, next charge, est. monthly cost
- [x] Dashboard: net worth + trend, month income/spent/net, budget progress, recent
      transactions, upcoming recurring
- [x] Reports: category spending, cashflow, net worth
- [x] Tests: budget-engine unit tests, API integration tests, recurring-detection
      unit tests, Playwright E2E smoke

Out of scope for v1: bank sync, credit-card payment categories, goals beyond monthly
targets, multi-budget, auth (it's local, single-user).

## 5. Milestones

1. **M1 — Engine:** schema, budget math, API for accounts/categories/transactions/budget. Unit + API tests green.
2. **M2 — Copilot layer:** auto-categorize, recurring detection, reports, dashboard API. Tests green.
3. **M3 — UI:** SPA with Budget, Transactions, Accounts, Recurring, Reports, Dashboard pages.
4. **M4 — E2E:** Playwright smoke test: create account → import/add transactions → assign budget → verify RTA/available → check dashboard.

## 6. How to run

```bash
npm start          # serves http://localhost:4321
npm test           # unit + API tests
npm run test:e2e   # browser end-to-end smoke test
```

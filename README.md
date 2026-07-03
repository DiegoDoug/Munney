# 💵 Munney

A **local-first personal finance app** that rebuilds the core of
[YNAB](https://www.ynab.com/) (zero-based envelope budgeting) and
[Copilot Money](https://www.copilot.money/) (dashboard, auto-categorization,
recurring detection, net worth) in one app that runs entirely on your machine.

No cloud, no accounts, no bank credentials. Your data is a single SQLite file
(`data/munney.db`). **Zero runtime dependencies** — everything ships with Node ≥ 22.

See [PLAN.md](PLAN.md) for the research summary and design.

## Quick start

```bash
npm start                # → http://localhost:4321
```

Optional demo data (6 months of realistic history):

```bash
npm run seed && npm start
```

## What it does

**From YNAB — the envelope budget engine**
- Give every dollar a job: income lands in **Ready to Assign**; you allocate it
  to categories until it hits zero.
- Per-month budget grid with **Assigned / Activity / Available**; envelope
  balances roll over month to month (overspending carries as negative).
- Monthly **targets** per category with funding progress.
- On-budget vs. off-budget (tracking) accounts, transfers between accounts.

**From Copilot — the money dashboard**
- **Dashboard**: net worth + 12-month trend, month income/spending/net, top
  category progress, upcoming recurring charges, recent transactions.
- **Auto-categorization** that learns payee → category from your corrections.
- **Recurring detection**: finds weekly/biweekly/monthly/yearly charges from
  history, predicts the next charge, estimates total monthly cost, and flags
  possibly-cancelled subscriptions.
- **Reports**: spending by category, income vs. spending, net worth over time.

**Getting money in**
- Manual entry (with income/transfer support) and **CSV import** with automatic
  duplicate detection — handles `Date,Description,Amount` and
  `Date,Description,Debit,Credit` shapes, `MM/DD/YYYY` or ISO dates,
  `$1,234.56` and `(12.34)` amount formats.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the app at http://localhost:4321 |
| `npm run seed` | Create demo data (refuses to overwrite an existing db) |
| `npm test` | Unit + API integration tests (`node:test`, in-memory SQLite) |
| `npm run test:e2e` | Browser end-to-end smoke test (Playwright + Chromium) |

Environment: `PORT` (default 4321), `MUNNEY_DB` (default `data/munney.db`),
`CHROMIUM_PATH` for the E2E test.

## Layout

```
server/   db schema, budget engine, categorizer, recurring detector, reports, HTTP API
public/   vanilla-JS SPA (hash routing, hand-rolled SVG charts, light/dark)
test/     budget/recurring/categorize unit tests, API tests, Playwright E2E
scripts/  demo-data seeder
```

# 💵 Munney

A **local-first personal finance app** that rebuilds the core of
[YNAB](https://www.ynab.com/) (zero-based envelope budgeting) and
[Copilot Money](https://www.copilot.money/) (dashboard, auto-categorization,
recurring detection, net worth) in one app that runs entirely on your machine.

No cloud, no accounts, no bank credentials. Your data is a single SQLite file
(`data/munney.db`). **Zero runtime dependencies** — everything ships with Node ≥ 22.

See [PLAN.md](PLAN.md) for the research summary and design.

A fresh install ships **empty** — no accounts, no transactions — with only a set
of starter category groups you can rename, reorder, or delete. Everything in
Munney is editable, so you can shape it into your own financial OS.

## Quick start

### Docker (deployable)

```bash
docker compose up -d --build      # → http://localhost:4321
```

Your data lives in the `munney-data` named volume and survives restarts and
rebuilds. Stop with `docker compose down` (add `-v` to also wipe the database).

Or build and run the image directly:

```bash
docker build -t munney .
docker run -d -p 4321:4321 -v munney-data:/app/data munney
```

### Local (Node ≥ 22)

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
- **Credit card payment categories**: budgeted spending on a card automatically
  moves money into that card's payment category, so the payment is always funded;
  paying the bill (a transfer) draws it down.
- **Targets**: set aside an amount every month, or save a total **by a date**
  (Munney computes the needed-per-month amount and tracks on-track/behind/funded).
- **Age of Money**: how old the dollars you spend are (FIFO over your income),
  on the dashboard — 30+ days means you're living on last month's income.
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
- Manual entry (with income/transfer support) and **AI-analyzed CSV / Markdown
  import** with automatic duplicate detection.
- **Mandatory import analyst (DeepSeek)**: every imported file is read and
  understood by a required AI agent — no fixed column schema needed. It finds
  every real transaction (any shape: standard columns, unusual headers, even
  free-form notes describing purchases), normalizes dates and signed amounts,
  and creates them directly. Header rows, totals, and running-balance lines
  are excluded automatically. If the file has no analyzable transactions, or
  the AI can't be reached, the import is refused so bad data never reaches
  your budget.

### Enabling AI-analyzed import

The import analyst needs a DeepSeek API key. It lives only in a local,
git-ignored `.env` file (never in code, never committed):

```bash
cp .env.example .env      # then paste your key into DEEPSEEK_API_KEY
```

Get a key at [platform.deepseek.com](https://platform.deepseek.com/). Without a
configured key the import endpoint is disabled (it refuses rather than importing
unanalyzed data). If you run Munney in a sandboxed/remote environment with an
outbound-egress allowlist, add `api.deepseek.com` to it so the AI can be
reached.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the app at http://localhost:4321 |
| `npm run seed` | Create demo data (refuses to overwrite an existing db) |
| `npm test` | Unit + API integration tests (`node:test`, in-memory SQLite) |
| `npm run test:e2e` | Browser end-to-end smoke test (Playwright + Chromium) |

Environment: `PORT` (default 4321), `HOST` (default `0.0.0.0`; set `127.0.0.1`
for local-only), `MUNNEY_DB` (default `data/munney.db`), `CHROMIUM_PATH` for the
E2E test. Import analyst: `DEEPSEEK_API_KEY` (required for import; read from
`.env`), `DEEPSEEK_MODEL` (default `deepseek-chat`), `DEEPSEEK_BASE_URL` (default
`https://api.deepseek.com`).

## Make it yours — everything is editable

Munney is built to be reshaped into your own financial OS. From the UI you can:

- **Accounts** — create, rename, change type/on-budget, close, or delete.
- **Category groups** — create, rename, reorder, delete.
- **Categories** — create, rename, move between groups, set monthly/by-date
  targets, hide, reorder, delete.
- **Transactions** — create, edit, delete, transfer, and CSV-import.
- **Auto-categorization rules** — view, re-point, or delete learned payee rules
  on the **Settings** page.
- **Reset** — wipe everything back to a fresh install (optionally keeping the
  starter categories) from **Settings → Reset all data**.

## Layout

```
server/   db schema, budget engine, categorizer, recurring detector, reports, HTTP API
public/   vanilla-JS SPA (hash routing, hand-rolled SVG charts, light/dark)
test/     budget/recurring/categorize unit tests, API tests, Playwright E2E
scripts/  demo-data seeder
```

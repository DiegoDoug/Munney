'use strict';
// Mandatory AI import analyst.
//
// Every CSV/Markdown import is routed through analyzeImport() before a single
// transaction is written. The agent is handed the raw file the user uploaded
// and must read and understand it itself — there is no rigid local column
// matching. It finds every real transaction line (whatever the file's shape:
// standard columns, unusual headers, free-form Markdown notes) and returns a
// normalized transaction list. Header rows, totals, running balances, and
// non-transaction prose are excluded by the agent, not by local regex rules.
//
// Talks to DeepSeek's OpenAI-compatible Chat Completions API using Node's
// built-in global fetch — no runtime dependencies. The API key lives only in
// .env (never in code, never committed).

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

function httpError(status, message, data) {
  const e = new Error(message);
  e.status = status;
  if (data !== undefined) e.data = data;
  return e;
}

function config(overrides = {}) {
  return {
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY,
    model: overrides.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
    baseUrl: (overrides.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: overrides.timeoutMs ?? 60000,
  };
}

function isConfigured(overrides = {}) {
  return Boolean(config(overrides).apiKey);
}

const SYSTEM_PROMPT = `You are Munney's import analyst, an expert at reading bank/financial statement files.

You receive the full raw contents of a file a user uploaded — CSV or Markdown — in ANY shape: standard columns, unusual or missing headers, extra commentary, free-form Markdown notes describing purchases, whatever. There is no fixed schema to match against; you must read and understand the file yourself.

Your job: find every real financial transaction described in the file and return it as normalized structured data. For each one, determine:
- date: normalized to ISO YYYY-MM-DD (infer the year if only month/day is given, using context from nearby dates or reasonable recency).
- payee: the merchant, person, or source involved.
- amount_cents: a signed integer number of cents. Outflows/debits/withdrawals/purchases/expenses are NEGATIVE. Inflows/deposits/credits/income/refunds are POSITIVE. Infer sign from context (a "withdrawal" or "purchase" column, parentheses, a minus sign, or wording like "paid", "spent", "received", "deposit") even if the file doesn't mark sign explicitly.
- memo: any extra descriptive detail (optional, empty string if none).
- category: your best-guess spending category name as plain text if the file states or clearly implies one (e.g. "Groceries", "Income"), otherwise omit/empty — Munney will auto-categorize when you leave it blank.

Do NOT include header rows, column-label rows, section titles, running/opening/closing balance lines, subtotal or total lines, or any other non-transaction content.

Respond with ONLY a JSON object, no prose, of this exact shape:
{
  "transactions": [
    { "date": "YYYY-MM-DD", "payee": string, "amount_cents": number, "memo": string, "category": string }
  ],
  "notes": string   // one short sentence describing what you found (e.g. counts, anything ambiguous)
}
If you cannot find any real transactions in the file, return an empty "transactions" array and explain why in "notes".`;

function buildUserMessage({ rawContent, format }) {
  return [
    `FORMAT: ${format}`,
    '',
    'RAW_FILE:',
    '"""',
    String(rawContent),
    '"""',
  ].join('\n');
}

// Low-level DeepSeek chat call. Returns the assistant message string.
async function chat(messages, overrides = {}) {
  const cfg = config(overrides);
  if (!cfg.apiKey) throw httpError(503, 'AI import analysis is not configured: set DEEPSEEK_API_KEY in .env');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw httpError(504, 'AI import analysis timed out — try again');
    throw httpError(502, `could not reach the AI analyst: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch {}
    throw httpError(res.status === 401 ? 401 : 502, `AI analyst error (${res.status}): ${msg}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw httpError(502, 'AI analyst returned invalid JSON envelope'); }
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw httpError(502, 'AI analyst returned an empty response');
  return content;
}

// Mandatory gate. The AI reads the raw file itself and returns the transactions
// it found — no local column parsing involved. Throws httpError if the
// analyst is unavailable/unreachable or returns something unusable.
async function analyzeImport({ rawContent, format }, overrides = {}) {
  const content = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage({ rawContent, format }) },
  ], overrides);

  let result;
  try { result = JSON.parse(content); } catch { throw httpError(502, 'AI analyst did not return valid JSON'); }

  if (!Array.isArray(result.transactions)) throw httpError(502, 'AI analyst response is missing a transactions array');

  return {
    transactions: result.transactions,
    notes: typeof result.notes === 'string' ? result.notes : '',
    model: config(overrides).model,
  };
}

module.exports = { analyzeImport, chat, isConfigured, config, httpError };

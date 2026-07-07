'use strict';
// Mandatory AI import auditor.
//
// Every CSV/Markdown import is routed through verifyImport() before a single
// transaction is written. The agent is handed (a) the raw file the user
// uploaded and (b) the exact list of transactions the parser intends to
// create, and must confirm they faithfully correspond to the file: same
// count, same dates, same signed amounts, same payees. If it finds a missing
// row, an extra row, or a mismatched field, the import is refused so the user
// can fix the file rather than silently poisoning their budget.
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

const SYSTEM_PROMPT = `You are Munney's import auditor, a meticulous financial data checker.

You receive:
1. RAW_FILE: the exact contents of a bank/statement file a user uploaded (CSV or Markdown).
2. PARSED_TRANSACTIONS: a JSON array of the transactions the importer intends to create from that file.

Each parsed transaction has: index, date (YYYY-MM-DD), payee, amount_cents (integer; outflows negative, inflows positive), amount_display (human dollars), memo.

Your job is to verify the parsed transactions faithfully represent the money movements described in RAW_FILE. Check that:
- Every real transaction line in RAW_FILE is represented exactly once (none missing, none invented).
- Each date matches the file (after normalizing formats like MM/DD/YYYY to ISO).
- Each signed amount matches: outflows/debits/withdrawals must be negative, inflows/deposits/credits positive. A wrong sign is an error.
- Each payee reasonably matches the file's description/merchant for that line.

Ignore header rows, totals/subtotal lines, opening/closing balance summaries, and blank lines — those are not transactions and should NOT appear in PARSED_TRANSACTIONS.

Respond with ONLY a JSON object, no prose, of this exact shape:
{
  "verified": boolean,          // true only if the parsed transactions correctly and completely match the file
  "expected_count": number,     // how many real transactions you counted in RAW_FILE
  "issues": [                   // empty when verified is true
    { "index": number|null, "field": "date"|"amount"|"payee"|"missing"|"extra"|"other", "detail": string }
  ],
  "notes": string               // one short sentence summarizing the check
}`;

function buildUserMessage({ rawContent, format, candidates }) {
  const compact = candidates.map((c, i) => ({
    index: i,
    date: c.date,
    payee: c.payee,
    amount_cents: c.amount_cents,
    amount_display: (c.amount_cents / 100).toFixed(2),
    memo: c.memo || '',
  }));
  return [
    `FORMAT: ${format}`,
    '',
    'RAW_FILE:',
    '"""',
    String(rawContent),
    '"""',
    '',
    'PARSED_TRANSACTIONS:',
    JSON.stringify(compact, null, 2),
  ].join('\n');
}

// Low-level DeepSeek chat call. Returns the assistant message string.
async function chat(messages, overrides = {}) {
  const cfg = config(overrides);
  if (!cfg.apiKey) throw httpError(503, 'AI import verification is not configured: set DEEPSEEK_API_KEY in .env');

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
    if (e.name === 'AbortError') throw httpError(504, 'AI import verification timed out — try again');
    throw httpError(502, `could not reach the AI verifier: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch {}
    throw httpError(res.status === 401 ? 401 : 502, `AI verifier error (${res.status}): ${msg}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw httpError(502, 'AI verifier returned invalid JSON envelope'); }
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw httpError(502, 'AI verifier returned an empty response');
  return content;
}

// Mandatory gate. Resolves to a normalized verdict, or throws httpError if the
// verifier is unavailable/unreachable. Never returns verified:true by guessing.
async function verifyImport({ rawContent, format, candidates }, overrides = {}) {
  const content = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage({ rawContent, format, candidates }) },
  ], overrides);

  let verdict;
  try { verdict = JSON.parse(content); } catch { throw httpError(502, 'AI verifier did not return valid JSON'); }

  const issues = Array.isArray(verdict.issues) ? verdict.issues : [];
  return {
    verified: verdict.verified === true && issues.length === 0,
    expected_count: Number.isFinite(verdict.expected_count) ? verdict.expected_count : null,
    parsed_count: candidates.length,
    issues,
    notes: typeof verdict.notes === 'string' ? verdict.notes : '',
    model: config(overrides).model,
  };
}

module.exports = { verifyImport, chat, isConfigured, config, httpError };

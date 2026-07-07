'use strict';
const path = require('node:path');

// Load secrets from .env (DeepSeek key for the mandatory import auditor) using
// Node's built-in loader — no dotenv dependency. Missing file is fine.
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env — AI import stays disabled */ }

const { createApp } = require('./app');
const agent = require('./agent');

const PORT = Number(process.env.PORT || 4321);
// Bind to all interfaces by default so the app is reachable inside a container;
// set HOST=127.0.0.1 to keep it local-only on a workstation.
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.MUNNEY_DB || path.join(__dirname, '..', 'data', 'munney.db');

const server = createApp({ dbPath: DB_PATH });
server.listen(PORT, HOST, () => {
  console.log(`Munney running at http://localhost:${PORT}  (db: ${DB_PATH}, host: ${HOST})`);
  console.log(agent.isConfigured()
    ? `AI import auditor: enabled (${agent.config().model})`
    : 'AI import auditor: DISABLED — set DEEPSEEK_API_KEY in .env to enable CSV/Markdown import');
});

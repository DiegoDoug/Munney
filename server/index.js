'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 4321);
// Bind to all interfaces by default so the app is reachable inside a container;
// set HOST=127.0.0.1 to keep it local-only on a workstation.
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.MUNNEY_DB || path.join(__dirname, '..', 'data', 'munney.db');

const server = createApp({ dbPath: DB_PATH });
server.listen(PORT, HOST, () => {
  console.log(`Munney running at http://localhost:${PORT}  (db: ${DB_PATH}, host: ${HOST})`);
});

'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 4321);
const DB_PATH = process.env.MUNNEY_DB || path.join(__dirname, '..', 'data', 'munney.db');

const server = createApp({ dbPath: DB_PATH });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Munney running at http://localhost:${PORT}  (db: ${DB_PATH})`);
});

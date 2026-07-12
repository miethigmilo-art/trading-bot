const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQUEEZE_DB_PATH || path.join(__dirname, 'squeeze.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db = null;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}

function logRun(module, symbol, status, message, startedAt) {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO collector_runs (module, symbol, status, message, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(module, symbol || null, status, message || null, startedAt);
}

function upsertTicker(symbol, name, sector) {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO tickers (symbol, name, sector) VALUES (?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET name = COALESCE(excluded.name, name), sector = COALESCE(excluded.sector, sector)`
    )
    .run(symbol, name || null, sector || null);
}

module.exports = { getDb, logRun, upsertTicker, DB_PATH };

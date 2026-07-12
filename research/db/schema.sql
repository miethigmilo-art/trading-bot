-- PROJECT SQUEEZE — Research Database Schema
-- Modul 1: Data Collector

CREATE TABLE IF NOT EXISTS tickers (
  symbol      TEXT PRIMARY KEY,
  name        TEXT,
  sector      TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  date        TEXT NOT NULL,
  open        REAL,
  high        REAL,
  low         REAL,
  close       REAL,
  adj_close   REAL,
  volume      INTEGER,
  UNIQUE(symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_symbol_date ON prices(symbol, date);

CREATE TABLE IF NOT EXISTS indicators (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  date        TEXT NOT NULL,
  name        TEXT NOT NULL,
  value       REAL,
  UNIQUE(symbol, date, name)
);
CREATE INDEX IF NOT EXISTS idx_indicators_symbol_date ON indicators(symbol, date);

CREATE TABLE IF NOT EXISTS fundamentals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol              TEXT NOT NULL,
  date                TEXT NOT NULL,
  market_cap          REAL,
  enterprise_value    REAL,
  shares_outstanding  REAL,
  float_shares        REAL,
  insider_percent     REAL,
  institution_percent REAL,
  pe_ratio            REAL,
  eps                 REAL,
  UNIQUE(symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_symbol_date ON fundamentals(symbol, date);

CREATE TABLE IF NOT EXISTS short_interest (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  settlement_date   TEXT NOT NULL,
  short_interest    REAL,
  avg_daily_volume  REAL,
  days_to_cover     REAL,
  percent_of_float  REAL,
  source            TEXT NOT NULL DEFAULT 'FINRA',
  UNIQUE(symbol, settlement_date)
);
CREATE INDEX IF NOT EXISTS idx_short_interest_symbol_date ON short_interest(symbol, settlement_date);

CREATE TABLE IF NOT EXISTS news (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  headline      TEXT NOT NULL,
  summary       TEXT,
  source        TEXT,
  url           TEXT,
  category      TEXT,
  UNIQUE(symbol, published_at, headline)
);
CREATE INDEX IF NOT EXISTS idx_news_symbol_date ON news(symbol, published_at);

-- Beobachtbarkeit: jeder Collector-Lauf wird protokolliert
CREATE TABLE IF NOT EXISTS collector_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  module        TEXT NOT NULL,
  symbol        TEXT,
  status        TEXT NOT NULL, -- ok | error | skipped
  message       TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_collector_runs_module ON collector_runs(module, started_at);

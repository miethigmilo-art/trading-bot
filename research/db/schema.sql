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

-- Modul 9: Wissensdatenbank — strukturiertes Wissen über historische Squeeze-Fälle.
-- Wird nicht automatisch befüllt, sondern kuratiert (siehe research/knowledge/events.json).
CREATE TABLE IF NOT EXISTS squeeze_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                TEXT NOT NULL,
  event_name            TEXT NOT NULL,
  start_date            TEXT NOT NULL,        -- Beginn des Squeeze
  peak_date             TEXT,                 -- Datum des Höchststands
  end_date              TEXT,                 -- Ende der Abwärtsbewegung danach
  trigger_type          TEXT,                 -- z.B. Social, Earnings, FDA, M&A, Short-Squeeze-Mechanik
  trigger_description   TEXT,                 -- Freitext: was genau war der Auslöser?
  chart_pattern         TEXT,                 -- z.B. Ascending Triangle, Cup & Handle
  metrics_at_trigger     TEXT,                -- JSON: {shortFloatPercent, floatShares, borrowFeePercent, daysToCover, rvol, ...}
  price_before           REAL,                -- Kurs vor Squeeze-Beginn
  price_peak             REAL,                -- Höchstkurs während des Squeeze
  gain_percent            REAL,               -- Anstieg in % (price_peak / price_before - 1)
  rise_duration_days      INTEGER,            -- Handelstage von start_date bis peak_date
  price_after             REAL,               -- Kurs nach dem Fall (Referenzpunkt in notes)
  drop_percent             REAL,              -- Fall in % vom Höchststand
  drop_duration_days       INTEGER,           -- Handelstage von peak_date bis end_date
  rule_would_detect        TEXT,              -- Welche Regel (Modul 7) hätte diesen Fall erkannt?
  rule_false_positive_risk TEXT,              -- Welche Regel hätte hier einen Fehlalarm ausgelöst?
  source                   TEXT,              -- Quelle(n) der Angaben, für Nachvollziehbarkeit
  notes                    TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, event_name)
);
CREATE INDEX IF NOT EXISTS idx_squeeze_events_symbol ON squeeze_events(symbol);

-- Modul 7: Regelgenerator — automatisch erzeugte Feature-Kombinationen mit
-- ihrer Bewertung gegen die Modul-6-Datenbasis (squeeze_events vs. Kontrollgruppe).
CREATE TABLE IF NOT EXISTS rules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  label                 TEXT NOT NULL,       -- lesbare Beschreibung, z.B. "RVOL >3 UND EMA20>EMA50"
  conditions            TEXT NOT NULL,       -- JSON-Array der verwendeten Predicate-Keys
  squeeze_hits          INTEGER NOT NULL,
  squeeze_applicable    INTEGER NOT NULL,    -- Anzahl Squeeze-Fälle, für die alle Features berechenbar waren
  control_hits          INTEGER NOT NULL,
  control_applicable    INTEGER NOT NULL,
  lift                  REAL,                -- (squeeze_hits/squeeze_applicable) / (control_hits/control_applicable)
  generated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conditions)
);
CREATE INDEX IF NOT EXISTS idx_rules_lift ON rules(lift);

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

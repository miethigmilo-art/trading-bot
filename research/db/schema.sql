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
-- Zwei Quellen: 'manual' = von Hand recherchiert und mit Quellenangabe belegt
-- (siehe research/knowledge/events.json), 'auto' = vom Squeeze-Detektor
-- (research/analysis/squeezeDetector.js) rein aus Kursverläufen erkannt, ohne
-- geprüfte Auslöser-Story — dafür in großer Zahl, als Datenbasis für Modul 6/7.
CREATE TABLE IF NOT EXISTS squeeze_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                TEXT NOT NULL,
  event_name            TEXT NOT NULL,
  detection_method      TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'
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
CREATE INDEX IF NOT EXISTS idx_squeeze_events_detection ON squeeze_events(detection_method);

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

-- Modul 4: Catalyst Engine — tägliche News-Artikelzahl + Sentiment-Score.
-- Einzige uns verfügbare Quelle mit echter historischer Tiefe ist Alpha
-- Vantage NEWS_SENTIMENT (Finnhub Free-Tier liefert nur ein rollierendes
-- Fenster der letzten Wochen, GDELT ist in dieser Umgebung dauerhaft
-- rate-limitiert). Teilt sich das 25-Calls/Tag-Limit mit den Indikatoren
-- (siehe research/collectors/alphaVantage.js) — wird daher nur inkrementell
-- befüllt (research/collectors/catalystBackfill.js verarbeitet pro Lauf so
-- viele offene Fälle wie Quota übrig ist und merkt sich den Fortschritt).
CREATE TABLE IF NOT EXISTS news_sentiment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  date           TEXT NOT NULL,
  article_count  INTEGER NOT NULL,
  avg_sentiment  REAL,  -- Alpha-Vantage-Skala: <=-0.35 bearish ... >=0.35 bullish
  source         TEXT NOT NULL DEFAULT 'alphavantage',
  UNIQUE(symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_news_sentiment_symbol_date ON news_sentiment(symbol, date);

-- Trackt, welche Kontrollgruppen-Fenster (normale Handelstage, kein Squeeze)
-- bereits per NEWS_SENTIMENT abgefragt wurden — auch wenn das Ergebnis 0
-- Artikel war. Ohne diese Tabelle ließe sich "abgefragt, aber keine News"
-- nicht von "noch nie abgefragt" unterscheiden (news_sentiment bekommt nur
-- Zeilen für Tage MIT Artikeln).
CREATE TABLE IF NOT EXISTS control_window_coverage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  queried_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, window_start)
);

-- Backtesting Engine: echte Walk-Forward-Trefferquote pro Regel — im
-- Unterschied zu `rules` (Lift am bereits bekannten Trigger-Tag) wird hier
-- JEDER Handelstag durchlaufen und geprüft, ob die Regel feuert und ob
-- danach tatsächlich ein neuer Squeeze folgt. Das ergibt eine echte
-- Precision ("Trefferquote") statt nur eine relative Häufigkeit.
CREATE TABLE IF NOT EXISTS backtest_results (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  label              TEXT NOT NULL,
  conditions         TEXT NOT NULL,
  lookahead_days     INTEGER NOT NULL,
  true_positives     INTEGER NOT NULL,
  false_positives    INTEGER NOT NULL,
  false_negatives    INTEGER NOT NULL,
  true_negatives     INTEGER NOT NULL,
  precision_pct      REAL,   -- TP / (TP + FP) — "Trefferquote": wenn die Regel feuert, wie oft folgt wirklich ein Squeeze
  recall_pct         REAL,   -- TP / (TP + FN) — wie viel % der echten Squeezes hätte die Regel erkannt
  base_rate_pct      REAL,   -- Anteil aller Tage, an denen überhaupt ein Squeeze binnen Lookahead folgte (Vergleichsmaßstab)
  run_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conditions, lookahead_days)
);
CREATE INDEX IF NOT EXISTS idx_backtest_precision ON backtest_results(precision_pct);

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

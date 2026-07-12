const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const { getPriceSeries } = require('../analysis/technicals');
const alphaVantage = require('./alphaVantage');

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WINDOW_DAYS = 14; // gleiche Fensterlänge wie bei den Squeeze-Fällen (catalystBackfill.js)
const STRIDE_DAYS = 90; // Abstand zwischen Kandidatenfenstern je Symbol (Kalendertage)
const MAX_PER_SYMBOL = 8; // verhindert, dass ein einzelnes Symbol mit langer Historie das ganze Budget zieht
const CONTROL_TARGET = 600; // Zielgröße der Kontrollgruppen-Stichprobe (~3-4x der kuratierten Squeeze-Fälle)
const AV_MIN_DATE = '2010-01-01'; // Alpha Vantage NEWS_SENTIMENT lehnt time_to vor diesem Datum ab

const CACHE_PATH = path.join(__dirname, '..', 'knowledge', 'control_window_cache.json');

function squeezeWindowsBySymbol(db) {
  const rows = db.prepare(`SELECT symbol, start_date, end_date FROM squeeze_events`).all();
  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ||= []).push({ start: r.start_date, end: r.end_date || r.start_date });
  return bySymbol;
}

/**
 * Deterministisch generierte Kandidatenfenster für die Kontrollgruppe: pro
 * Symbol alle STRIDE_DAYS ein WINDOW_DAYS-Fenster, das keinen Squeeze-Zeitraum
 * (inkl. 10 Tage Puffer) berührt. Deterministisch (kein Zufall), damit jeder
 * Lauf dieselben Kandidaten in derselben Reihenfolge erzeugt.
 */
function generateCandidateWindows(db) {
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);
  const squeezeWindows = squeezeWindowsBySymbol(db);
  const candidates = [];

  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length < 30) continue;
    const dates = series.map((r) => r.date);
    const windows = (squeezeWindows[symbol] || []).map((w) => [
      new Date(new Date(w.start).getTime() - 10 * DAY_MS).toISOString().slice(0, 10),
      new Date(new Date(w.end).getTime() + 10 * DAY_MS).toISOString().slice(0, 10),
    ]);

    let count = 0;
    for (let i = 0; i < dates.length && count < MAX_PER_SYMBOL; i += STRIDE_DAYS) {
      const windowStart = dates[i];
      const windowEnd = dates[Math.min(i + WINDOW_DAYS, dates.length - 1)];
      if (windowEnd < AV_MIN_DATE) continue; // Alpha Vantage hat für dieses Fenster ohnehin keine Daten
      const overlapsSqueeze = windows.some(([s, e]) => windowStart <= e && windowEnd >= s);
      if (overlapsSqueeze) continue;
      candidates.push({ symbol, from: windowStart, to: windowEnd });
      count += 1;
    }
  }
  return candidates;
}

function pendingControlWindows(db, limit) {
  const alreadyCovered = db.prepare(`SELECT COUNT(*) AS n FROM control_window_coverage`).get().n;
  const budget = Math.max(0, Math.min(limit, CONTROL_TARGET - alreadyCovered));
  if (budget === 0) return [];

  const covered = new Set(
    db.prepare(`SELECT symbol || '|' || window_start AS k FROM control_window_coverage`).all().map((r) => r.k)
  );
  const candidates = generateCandidateWindows(db).filter((c) => !covered.has(`${c.symbol}|${c.from}`));
  return candidates.slice(0, budget);
}

function importCache(db) {
  if (!fs.existsSync(CACHE_PATH)) return 0;
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const insertCoverage = db.prepare(
    `INSERT INTO control_window_coverage (symbol, window_start, window_end) VALUES (@symbol, @windowStart, @windowEnd)
     ON CONFLICT(symbol, window_start) DO NOTHING`
  );
  const insertMany = db.transaction((data) => {
    for (const r of data.coverage || []) insertCoverage.run(r);
  });
  insertMany(cache);

  // cache.newsSentiment enthält Zeilen mehrerer Symbole gemischt — nach Symbol
  // gruppieren, da storeNewsSentiment ein einzelnes Symbol pro Aufruf erwartet.
  const bySymbol = {};
  for (const row of cache.newsSentiment || []) (bySymbol[row.symbol] ||= []).push(row);
  for (const [symbol, rows] of Object.entries(bySymbol)) {
    alphaVantage.storeNewsSentiment(db, symbol, rows, 'alphavantage-control');
  }
  return (cache.coverage || []).length;
}

function exportCache(db) {
  const coverage = db.prepare(`SELECT symbol, window_start AS windowStart, window_end AS windowEnd FROM control_window_coverage`).all();
  const newsSentiment = db
    .prepare(`SELECT symbol, date, article_count AS articleCount, avg_sentiment AS avgSentiment FROM news_sentiment WHERE source = 'alphavantage-control'`)
    .all();
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ coverage, newsSentiment }, null, 2) + '\n');
  return coverage.length;
}

/**
 * Verarbeitet pro Lauf so viele Kontrollfenster wie Quota übrig ist (nach
 * Abzug dessen, was catalystBackfill.js für die kuratierten Fälle schon
 * verbraucht hat — beide teilen sich dieselbe Alpha-Vantage-Tageskapazität).
 * Bricht ab, sobald CONTROL_TARGET erreicht ist.
 */
async function backfillControlWindows() {
  const db = getDb();
  importCache(db);

  const remaining = Math.max(0, alphaVantage.totalDailyCapacity() - alphaVantage.callsUsedToday(db));
  const todo = pendingControlWindows(db, remaining);
  const results = [];

  const insertCoverage = db.prepare(
    `INSERT INTO control_window_coverage (symbol, window_start, window_end) VALUES (@symbol, @from, @to)
     ON CONFLICT(symbol, window_start) DO NOTHING`
  );

  for (const w of todo) {
    const rows = await alphaVantage.fetchNewsSentiment(w.symbol, { from: w.from, to: w.to }, db);
    if (rows.skipped) {
      results.push({ symbol: w.symbol, status: 'skipped', reason: rows.reason });
      break;
    }
    if (rows.error) {
      results.push({ symbol: w.symbol, status: 'error', message: rows.error });
    } else {
      const count = alphaVantage.storeNewsSentiment(db, w.symbol, rows, 'alphavantage-control');
      insertCoverage.run({ symbol: w.symbol, from: w.from, to: w.to });
      results.push({ symbol: w.symbol, status: 'ok', count });
    }

    if (todo.indexOf(w) < todo.length - 1) await sleep(13000); // 5 Calls/Minute pro Key einhalten
  }

  const exportedCoverage = exportCache(db);
  const totalCovered = db.prepare(`SELECT COUNT(*) AS n FROM control_window_coverage`).get().n;

  return { results, totalCovered, target: CONTROL_TARGET, exportedCoverage };
}

module.exports = { backfillControlWindows, pendingControlWindows, generateCandidateWindows, CONTROL_TARGET };

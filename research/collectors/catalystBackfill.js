const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const alphaVantage = require('./alphaVantage');

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CACHE_PATH = path.join(__dirname, '..', 'knowledge', 'news_sentiment_cache.json');

/**
 * Die SQLite-DB liegt nur lokal im (ephemeren) Container und ist bewusst
 * nicht in Git — ohne Sync würde jeder Tageslauf der geplanten Routine bei
 * Null anfangen, statt an der Warteschlange weiterzumachen. Deshalb wird
 * news_sentiment vor jedem Lauf aus diesem git-versionierten Snapshot
 * importiert und danach wieder exportiert.
 */
function importCache(db) {
  if (!fs.existsSync(CACHE_PATH)) return 0;
  const rows = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const insert = db.prepare(
    `INSERT INTO news_sentiment (symbol, date, article_count, avg_sentiment, source)
     VALUES (@symbol, @date, @articleCount, @avgSentiment, @source)
     ON CONFLICT(symbol, date) DO UPDATE SET
       article_count = excluded.article_count, avg_sentiment = excluded.avg_sentiment`
  );
  const insertMany = db.transaction((data) => {
    for (const r of data) insert.run(r);
  });
  insertMany(rows);
  return rows.length;
}

function exportCache(db) {
  const rows = db
    .prepare(`SELECT symbol, date, article_count AS articleCount, avg_sentiment AS avgSentiment, source FROM news_sentiment ORDER BY symbol, date`)
    .all();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(rows, null, 2) + '\n');
  return rows.length;
}

/**
 * Fälle, für die noch keine News-Sentiment-Daten im relevanten Zeitfenster
 * (14 Tage vor start_date bis end_date) vorliegen. Nur 'manual'/'verified'
 * Fälle — die 572 blind erkannten 'auto'-Fälle sind zu unsicher (evtl. gar
 * kein echter Squeeze), um die knappe Quota dafür zu verbrauchen.
 */
function pendingEvents(db, limit) {
  return db
    .prepare(
      `SELECT DISTINCT symbol, start_date, end_date FROM squeeze_events se
       WHERE detection_method IN ('manual', 'verified')
       AND NOT EXISTS (
         SELECT 1 FROM news_sentiment ns
         WHERE ns.symbol = se.symbol
           AND ns.date BETWEEN date(se.start_date, '-14 days') AND se.end_date
       )
       ORDER BY start_date DESC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * Verarbeitet pro Lauf so viele offene Fälle wie das Alpha-Vantage-Tageslimit
 * (geteilt mit den Indikator-Calls) noch hergibt. Bei 25 Calls/Tag und ~174
 * kuratierten Fällen braucht das mehrere Tage — die NOT-EXISTS-Abfrage oben
 * sorgt dafür, dass jeder Lauf automatisch dort weitermacht, wo der letzte
 * aufgehört hat.
 */
async function backfillCatalystData() {
  const db = getDb();
  importCache(db);

  const dailyLimit = Number(process.env.ALPHAVANTAGE_DAILY_LIMIT || 25);
  const remaining = Math.max(0, dailyLimit - alphaVantage.callsUsedToday(db));
  const todo = pendingEvents(db, remaining);
  const results = [];

  for (const ev of todo) {
    const from = new Date(new Date(ev.start_date).getTime() - 14 * DAY_MS);
    const to = ev.end_date || ev.start_date;

    const rows = await alphaVantage.fetchNewsSentiment(ev.symbol, { from, to }, db);
    if (rows.skipped) {
      results.push({ symbol: ev.symbol, status: 'skipped', reason: rows.reason });
      break;
    }
    if (rows.error) {
      results.push({ symbol: ev.symbol, status: 'error', message: rows.error });
    } else {
      const count = alphaVantage.storeNewsSentiment(db, ev.symbol, rows);
      results.push({ symbol: ev.symbol, status: 'ok', count });
    }

    if (todo.indexOf(ev) < todo.length - 1) await sleep(13000); // 5 Calls/Minute einhalten
  }

  const stillPending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT symbol, start_date, end_date FROM squeeze_events se
         WHERE detection_method IN ('manual', 'verified')
         AND NOT EXISTS (
           SELECT 1 FROM news_sentiment ns
           WHERE ns.symbol = se.symbol AND ns.date BETWEEN date(se.start_date, '-14 days') AND se.end_date
         )
       )`
    )
    .get().n;

  const exported = exportCache(db);

  return { results, stillPending, exported };
}

module.exports = { backfillCatalystData, pendingEvents, importCache, exportCache, CACHE_PATH };

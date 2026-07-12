const { getDb } = require('../db/database');
const alphaVantage = require('./alphaVantage');

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  return { results, stillPending };
}

module.exports = { backfillCatalystData, pendingEvents };

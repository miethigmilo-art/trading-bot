const { getDb, logRun, upsertTicker } = require('../db/database');
const yahoo = require('./yahooFinance');
const finra = require('./finra');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lädt für jedes in squeeze_events erfasste Symbol genug Kurshistorie nach,
 * um EMA200/RVOL am Trigger-Datum berechnen zu können (~300 Tage Vorlauf vor
 * start_date bis etwas nach end_date). Symbole ohne Kursdaten mehr bei Yahoo
 * (z.B. inzwischen delistete/fusionierte Ticker wie SPRT) schlagen fehl und
 * werden geloggt statt den Lauf abzubrechen — die manuell erfassten Werte in
 * squeeze_events bleiben davon unberührt.
 */
async function backfillEventWindows() {
  const db = getDb();
  const events = db.prepare(`SELECT DISTINCT symbol, start_date, end_date FROM squeeze_events`).all();
  const results = [];

  for (const ev of events) {
    const from = new Date(new Date(ev.start_date).getTime() - 300 * DAY_MS);
    const to = new Date((ev.end_date ? new Date(ev.end_date).getTime() : Date.now()) + 30 * DAY_MS);

    upsertTicker(ev.symbol);
    const startedAt = new Date().toISOString();
    try {
      const bars = await yahoo.fetchDailyBars(ev.symbol, { from, to });
      const count = yahoo.storeBars(db, ev.symbol, bars);
      logRun('yahooFinance:backfillEvents', ev.symbol, 'ok', `${count} Datensätze (${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)})`, startedAt);
      results.push({ symbol: ev.symbol, status: 'ok', count });
    } catch (err) {
      logRun('yahooFinance:backfillEvents', ev.symbol, 'error', err.message, startedAt);
      results.push({ symbol: ev.symbol, status: 'error', message: err.message });
    }

    const finraStarted = new Date().toISOString();
    try {
      const rows = await finra.fetchShortInterest(ev.symbol, { since: from.toISOString().slice(0, 10) });
      const count = finra.storeShortInterest(db, ev.symbol, rows);
      logRun('finra:backfillEvents', ev.symbol, 'ok', `${count} Datensätze`, finraStarted);
      results.push({ symbol: ev.symbol, status: 'ok', module: 'finra', count });
    } catch (err) {
      logRun('finra:backfillEvents', ev.symbol, 'error', err.message, finraStarted);
      results.push({ symbol: ev.symbol, status: 'error', module: 'finra', message: err.message });
    }
  }

  return results;
}

module.exports = { backfillEventWindows };

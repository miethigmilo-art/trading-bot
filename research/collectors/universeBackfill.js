const { getDb, logRun, upsertTicker } = require('../db/database');
const yahoo = require('./yahooFinance');
const finra = require('./finra');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Schlanker Backfill für viele Symbole gleichzeitig: NUR Kurse (Yahoo) und
 * Short Interest (FINRA), bewusst OHNE Finnhub/Alpha Vantage — die werden
 * hier nicht gebraucht (EMA/RVOL berechnen wir lokal aus den Kursen, siehe
 * technicals.js) und würden bei z.B. 80 Symbolen sofort das
 * Alpha-Vantage-Tageslimit sprengen bzw. den Lauf stundenlang machen.
 */
async function backfillUniverse(symbols, { range = '5y' } = {}) {
  const db = getDb();
  const results = [];

  for (const symbol of symbols) {
    upsertTicker(symbol);

    const priceStarted = new Date().toISOString();
    try {
      const bars = await yahoo.fetchDailyBars(symbol, { range });
      const count = yahoo.storeBars(db, symbol, bars);
      logRun('yahooFinance:universe', symbol, 'ok', `${count} Datensätze`, priceStarted);
      results.push({ symbol, module: 'yahoo', status: 'ok', count });
    } catch (err) {
      logRun('yahooFinance:universe', symbol, 'error', err.message, priceStarted);
      results.push({ symbol, module: 'yahoo', status: 'error', message: err.message });
    }

    const finraStarted = new Date().toISOString();
    try {
      const rows = await finra.fetchShortInterest(symbol, { since: '2019-01-01' });
      const count = finra.storeShortInterest(db, symbol, rows);
      logRun('finra:universe', symbol, 'ok', `${count} Datensätze`, finraStarted);
      results.push({ symbol, module: 'finra', status: 'ok', count });
    } catch (err) {
      logRun('finra:universe', symbol, 'error', err.message, finraStarted);
      results.push({ symbol, module: 'finra', status: 'error', message: err.message });
    }

    await sleep(150);
  }

  return results;
}

module.exports = { backfillUniverse };

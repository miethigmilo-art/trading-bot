const { getDb, logRun, upsertTicker } = require('../db/database');
const yahoo = require('./yahooFinance');
const finra = require('./finra');
const finnhub = require('./finnhub');
const alphaVantage = require('./alphaVantage');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runStep(db, moduleName, symbol, fn) {
  const startedAt = new Date().toISOString();
  try {
    const count = await fn();
    logRun(moduleName, symbol, 'ok', `${count ?? 0} Datensätze`, startedAt);
    return { module: moduleName, symbol, status: 'ok', count };
  } catch (err) {
    logRun(moduleName, symbol, 'error', err.message, startedAt);
    return { module: moduleName, symbol, status: 'error', message: err.message };
  }
}

/**
 * Sammelt für jedes Symbol der Watchlist: Kurse (Yahoo), Short Interest (FINRA),
 * und — sofern API-Keys gesetzt sind — Fundamentaldaten/News (Finnhub) und
 * technische Indikatoren (Alpha Vantage). Fehlende Keys führen zu einem
 * geloggten "skipped" statt einem Absturz.
 */
async function runDailyCollection(symbols, { priceRange = '5d' } = {}) {
  const db = getDb();
  const results = [];

  for (const symbol of symbols) {
    upsertTicker(symbol);

    results.push(
      await runStep(db, 'yahooFinance', symbol, async () => {
        const bars = await yahoo.fetchDailyBars(symbol, { range: priceRange });
        return yahoo.storeBars(db, symbol, bars);
      })
    );

    results.push(
      await runStep(db, 'finra', symbol, async () => {
        const rows = await finra.fetchShortInterest(symbol);
        return finra.storeShortInterest(db, symbol, rows);
      })
    );

    if (process.env.FINNHUB_API_KEY) {
      results.push(
        await runStep(db, 'finnhub', symbol, async () => {
          const fundamentals = await finnhub.fetchFundamentals(symbol);
          finnhub.storeFundamentals(db, symbol, fundamentals);
          const news = await finnhub.fetchNews(symbol);
          return finnhub.storeNews(db, symbol, news);
        })
      );
    } else {
      logRun('finnhub', symbol, 'skipped', 'FINNHUB_API_KEY nicht gesetzt', new Date().toISOString());
    }

    if (process.env.ALPHAVANTAGE_API_KEY) {
      results.push(
        await runStep(db, 'alphaVantage', symbol, async () => {
          const indicators = await alphaVantage.fetchLatestIndicators(symbol, db);
          return alphaVantage.storeIndicators(db, symbol, indicators);
        })
      );
    } else {
      logRun('alphaVantage', symbol, 'skipped', 'ALPHAVANTAGE_API_KEY nicht gesetzt', new Date().toISOString());
    }

    await sleep(500); // kurze Pause zwischen Symbolen, schont Free-Tier-Limits
  }

  return results;
}

module.exports = { runDailyCollection };

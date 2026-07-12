const axios = require('axios');
const { logRun } = require('../db/database');

const client = axios.create({
  baseURL: 'https://www.alphavantage.co',
  timeout: 20000,
});

const DEFAULT_INDICATORS = [
  { name: 'EMA20', func: 'EMA', time_period: 20 },
  { name: 'EMA50', func: 'EMA', time_period: 50 },
  { name: 'EMA100', func: 'EMA', time_period: 100 },
  { name: 'EMA200', func: 'EMA', time_period: 200 },
];

// Mehrere kostenlose Alpha-Vantage-Keys lassen sich zu je 25 Calls/Tag
// registrieren — ALPHAVANTAGE_API_KEYS (kommagetrennt) rotiert automatisch
// durch alle, ALPHAVANTAGE_API_KEY bleibt als Fallback für einen einzelnen Key.
function getKeys() {
  const multi = process.env.ALPHAVANTAGE_API_KEYS;
  if (multi) {
    const keys = multi.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length) return keys;
  }
  const single = process.env.ALPHAVANTAGE_API_KEY;
  return single ? [single] : [];
}

function requireKeys() {
  const keys = getKeys();
  if (keys.length === 0) throw new Error('ALPHAVANTAGE_API_KEY(S) fehlt in der Umgebung');
  return keys;
}

const PER_KEY_DAILY_LIMIT = () => Number(process.env.ALPHAVANTAGE_DAILY_LIMIT || 25);
const moduleNameForKey = (index) => `alphaVantageCall#${index}`;

// Jeder Call wird unter einem eigenen Modulnamen PRO KEY-INDEX protokolliert
// (nicht dem Sammel-Log pro Symbol aus runAll.js), damit sich das Tageslimit
// pro Key zuverlässig und unabhängig von den anderen Keys einhalten lässt.
function callsUsedTodayForKey(db, index) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM collector_runs WHERE module = ? AND date(started_at) = date('now')`)
    .get(moduleNameForKey(index));
  return row.n;
}

function callsUsedToday(db) {
  return getKeys().reduce((sum, _key, i) => sum + callsUsedTodayForKey(db, i), 0);
}

function totalDailyCapacity() {
  return getKeys().length * PER_KEY_DAILY_LIMIT();
}

/** Ersten Key mit noch freiem Tageskontingent finden, oder null wenn alle ausgeschöpft sind. */
function pickAvailableKey(db) {
  const keys = requireKeys();
  const limit = PER_KEY_DAILY_LIMIT();
  for (let i = 0; i < keys.length; i++) {
    if (callsUsedTodayForKey(db, i) < limit) return { key: keys[i], index: i };
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holt den jeweils neuesten Wert für eine Liste von Indikatoren.
 * Respektiert das Tageslimit über `db` (siehe callsUsedToday) und pausiert
 * zwischen Calls, um das 5/Minute-Limit einzuhalten.
 */
async function fetchLatestIndicators(symbol, db, { indicators = DEFAULT_INDICATORS } = {}) {
  requireKeys();
  const results = [];

  for (const ind of indicators) {
    const picked = pickAvailableKey(db);
    if (!picked) {
      results.push({ name: ind.name, skipped: true, reason: 'Tageslimit erreicht (alle Keys)' });
      continue;
    }

    const startedAt = new Date().toISOString();
    const { data } = await client.get('/query', {
      params: {
        function: ind.func,
        symbol,
        interval: 'daily',
        time_period: ind.time_period,
        series_type: 'close',
        apikey: picked.key,
      },
    });

    const series = data?.[`Technical Analysis: ${ind.func}`];
    if (!series) {
      const msg = data?.Note || data?.Information || data?.['Error Message'] || 'Keine Daten zurückgegeben';
      results.push({ name: ind.name, error: msg });
      logRun(moduleNameForKey(picked.index), symbol, 'error', `${ind.name}: ${msg}`, startedAt);
    } else {
      const [date, values] = Object.entries(series)[0] || [];
      results.push({ name: ind.name, date, value: values ? Number(values[ind.func]) : null });
      logRun(moduleNameForKey(picked.index), symbol, 'ok', ind.name, startedAt);
    }

    if (indicators.indexOf(ind) < indicators.length - 1) await sleep(13000); // 5 Calls/Minute pro Key einhalten
  }

  return results;
}

function fmtAvTimestamp(date) {
  return new Date(date).toISOString().slice(0, 10).replace(/-/g, '') + 'T0000';
}

/**
 * Modul 4 (Catalyst Engine): News-Artikelzahl + Sentiment pro Tag für ein
 * Zeitfenster. Teilt sich das Tageslimit mit fetchLatestIndicators (gleiches
 * Konto, gleicher Modulname 'alphaVantageCall' für die Quota-Zählung).
 * Gibt { skipped: true } zurück, wenn das Tageslimit bereits erreicht ist,
 * statt einen Call zu verschwenden.
 */
async function fetchNewsSentiment(symbol, { from, to }, db) {
  requireKeys();
  const picked = pickAvailableKey(db);
  if (!picked) return { skipped: true, reason: 'Tageslimit erreicht (alle Keys)' };

  const startedAt = new Date().toISOString();
  const { data } = await client.get('/query', {
    params: {
      function: 'NEWS_SENTIMENT',
      tickers: symbol,
      time_from: fmtAvTimestamp(from),
      time_to: fmtAvTimestamp(to),
      limit: 200,
      apikey: picked.key,
    },
  });

  if (!Array.isArray(data?.feed)) {
    const msg = data?.Note || data?.Information || data?.['Error Message'] || 'Keine Daten zurückgegeben';
    logRun(moduleNameForKey(picked.index), symbol, 'error', `NEWS_SENTIMENT: ${msg}`, startedAt);
    return { error: msg };
  }
  logRun(moduleNameForKey(picked.index), symbol, 'ok', `NEWS_SENTIMENT: ${data.feed.length} Artikel`, startedAt);

  const byDate = {};
  for (const item of data.feed) {
    const date = item.time_published?.slice(0, 8);
    if (!date) continue;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const tickerSentiment = item.ticker_sentiment?.find((t) => t.ticker === symbol);
    const score = tickerSentiment ? Number(tickerSentiment.ticker_sentiment_score) : Number(item.overall_sentiment_score);
    (byDate[iso] ||= []).push(score);
  }

  return Object.entries(byDate).map(([date, scores]) => ({
    date,
    articleCount: scores.length,
    avgSentiment: scores.reduce((a, b) => a + b, 0) / scores.length,
  }));
}

function storeNewsSentiment(db, symbol, rows) {
  const insert = db.prepare(
    `INSERT INTO news_sentiment (symbol, date, article_count, avg_sentiment)
     VALUES (@symbol, @date, @articleCount, @avgSentiment)
     ON CONFLICT(symbol, date) DO UPDATE SET
       article_count = excluded.article_count, avg_sentiment = excluded.avg_sentiment`
  );
  const insertMany = db.transaction((data) => {
    for (const row of data) insert.run({ symbol, ...row });
  });
  insertMany(rows);
  return rows.length;
}

function storeIndicators(db, symbol, results) {
  const insert = db.prepare(
    `INSERT INTO indicators (symbol, date, name, value) VALUES (@symbol, @date, @name, @value)
     ON CONFLICT(symbol, date, name) DO UPDATE SET value = excluded.value`
  );
  let stored = 0;
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      if (row.skipped || row.error || !row.date) continue;
      insert.run({ symbol, date: row.date, name: row.name, value: row.value });
      stored += 1;
    }
  });
  insertMany(results);
  return stored;
}

module.exports = {
  fetchLatestIndicators,
  storeIndicators,
  fetchNewsSentiment,
  storeNewsSentiment,
  callsUsedToday,
  totalDailyCapacity,
  getKeys,
  DEFAULT_INDICATORS,
};

const axios = require('axios');

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

function requireKey() {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) throw new Error('ALPHAVANTAGE_API_KEY fehlt in der Umgebung');
  return key;
}

// Free-Tier: 5 Calls/Minute, 25 Calls/Tag. Jeder Indikator kostet einen eigenen Call,
// darum zählen wir bereits erfolgreich geloggte Alpha-Vantage-Calls des heutigen Tages
// und brechen ab, statt das Tageslimit zu sprengen.
function callsUsedToday(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM collector_runs
       WHERE module = 'alphaVantage' AND status = 'ok' AND date(started_at) = date('now')`
    )
    .get();
  return row.n;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holt den jeweils neuesten Wert für eine Liste von Indikatoren.
 * Respektiert das Tageslimit über `db` (siehe callsUsedToday) und pausiert
 * zwischen Calls, um das 5/Minute-Limit einzuhalten.
 */
async function fetchLatestIndicators(symbol, db, { indicators = DEFAULT_INDICATORS } = {}) {
  const token = requireKey();
  const dailyLimit = Number(process.env.ALPHAVANTAGE_DAILY_LIMIT || 25);
  const results = [];

  for (const ind of indicators) {
    if (callsUsedToday(db) + results.length >= dailyLimit) {
      results.push({ name: ind.name, skipped: true, reason: 'Tageslimit erreicht' });
      continue;
    }

    const { data } = await client.get('/query', {
      params: {
        function: ind.func,
        symbol,
        interval: 'daily',
        time_period: ind.time_period,
        series_type: 'close',
        apikey: token,
      },
    });

    const series = data?.[`Technical Analysis: ${ind.func}`];
    if (!series) {
      const msg = data?.Note || data?.Information || data?.['Error Message'] || 'Keine Daten zurückgegeben';
      results.push({ name: ind.name, error: msg });
    } else {
      const [date, values] = Object.entries(series)[0] || [];
      results.push({ name: ind.name, date, value: values ? Number(values[ind.func]) : null });
    }

    if (indicators.indexOf(ind) < indicators.length - 1) await sleep(13000); // 5 Calls/Minute einhalten
  }

  return results;
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

module.exports = { fetchLatestIndicators, storeIndicators, DEFAULT_INDICATORS };

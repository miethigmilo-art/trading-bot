const axios = require('axios');

// Yahoo's chart endpoint blocks requests without a browser-like User-Agent (429).
const client = axios.create({
  baseURL: 'https://query1.finance.yahoo.com',
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  },
});

/**
 * Fetch daily OHLCV bars for a symbol.
 * range: '5d' for the daily collector run, larger ranges (e.g. '2y') for backfill.
 */
async function fetchDailyBars(symbol, { range = '5d' } = {}) {
  const { data } = await client.get(`/v8/finance/chart/${encodeURIComponent(symbol)}`, {
    params: { interval: '1d', range, includePrePost: false },
  });

  const result = data?.chart?.result?.[0];
  if (!result) {
    const err = data?.chart?.error;
    throw new Error(err ? `${err.code}: ${err.description}` : 'Kein Ergebnis von Yahoo Finance');
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose || [];

  return timestamps
    .map((ts, i) => {
      const close = quote.close?.[i];
      if (close == null) return null; // Yahoo liefert null für nicht gehandelte Tage im Range
      return {
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: quote.open?.[i] ?? null,
        high: quote.high?.[i] ?? null,
        low: quote.low?.[i] ?? null,
        close,
        adjClose: adjClose[i] ?? close,
        volume: quote.volume?.[i] ?? null,
      };
    })
    .filter(Boolean);
}

function storeBars(db, symbol, bars) {
  const insert = db.prepare(
    `INSERT INTO prices (symbol, date, open, high, low, close, adj_close, volume)
     VALUES (@symbol, @date, @open, @high, @low, @close, @adjClose, @volume)
     ON CONFLICT(symbol, date) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, adj_close = excluded.adj_close, volume = excluded.volume`
  );
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run({ symbol, ...row });
  });
  insertMany(bars);
  return bars.length;
}

module.exports = { fetchDailyBars, storeBars };

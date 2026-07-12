const axios = require('axios');

// FINRA's "Consolidated Short Interest" dataset is public and needs no API key.
// It is published bi-monthly (mid-month and end-of-month settlement dates).
const client = axios.create({
  baseURL: 'https://api.finra.org',
  timeout: 20000,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
});

/**
 * Fetch short interest settlements for a symbol.
 * Without a lower bound FINRA returns the OLDEST records first, so we always
 * pass a `since` date; default is ~14 months back (covers the last ~28 bi-monthly
 * settlements). Pass an earlier `since` (e.g. '2015-01-01') to backfill full history.
 */
async function fetchShortInterest(symbol, { since, limit = 50 } = {}) {
  const sinceDate = since || new Date(Date.now() - 425 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data } = await client.post('/data/group/otcMarket/name/consolidatedShortInterest', {
    limit,
    compareFilters: [
      { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: symbol },
      { compareType: 'GTE', fieldName: 'settlementDate', fieldValue: sinceDate },
    ],
  });

  if (!Array.isArray(data)) {
    throw new Error(typeof data === 'string' ? data : data?.message || 'Unerwartete FINRA-Antwort');
  }

  return data
    .map((row) => ({
      settlementDate: row.settlementDate,
      shortInterest: row.currentShortPositionQuantity ?? null,
      avgDailyVolume: row.averageDailyVolumeQuantity ?? null,
      daysToCover: row.daysToCoverQuantity ?? null,
    }))
    .sort((a, b) => (a.settlementDate < b.settlementDate ? 1 : -1));
}

function storeShortInterest(db, symbol, rows) {
  const insert = db.prepare(
    `INSERT INTO short_interest (symbol, settlement_date, short_interest, avg_daily_volume, days_to_cover, source)
     VALUES (@symbol, @settlementDate, @shortInterest, @avgDailyVolume, @daysToCover, 'FINRA')
     ON CONFLICT(symbol, settlement_date) DO UPDATE SET
       short_interest = excluded.short_interest,
       avg_daily_volume = excluded.avg_daily_volume,
       days_to_cover = excluded.days_to_cover`
  );
  const insertMany = db.transaction((data) => {
    for (const row of data) insert.run({ symbol, ...row });
  });
  insertMany(rows);
  return rows.length;
}

module.exports = { fetchShortInterest, storeShortInterest };

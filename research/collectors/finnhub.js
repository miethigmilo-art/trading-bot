const axios = require('axios');

const client = axios.create({
  baseURL: 'https://finnhub.io/api/v1',
  timeout: 15000,
});

function requireKey() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY fehlt in der Umgebung');
  return key;
}

/**
 * Market cap, shares outstanding, PE/EPS via /stock/profile2 + /stock/metric.
 * Insider-/Institutionsquoten sind auf dem Finnhub Free-Tier nicht verfügbar
 * (bleiben null, bis ein bezahlter Plan oder eine andere Quelle das liefert).
 */
async function fetchFundamentals(symbol) {
  const token = requireKey();
  const [{ data: profile }, { data: metrics }] = await Promise.all([
    client.get('/stock/profile2', { params: { symbol, token } }),
    client.get('/stock/metric', { params: { symbol, metric: 'all', token } }),
  ]);

  if (!profile || Object.keys(profile).length === 0) {
    throw new Error(`Kein Finnhub-Profil für ${symbol} gefunden`);
  }

  const m = metrics?.metric || {};
  return {
    date: new Date().toISOString().slice(0, 10),
    marketCap: profile.marketCapitalization ?? null, // in Mio. USD (Finnhub-Konvention)
    enterpriseValue: null,
    sharesOutstanding: profile.shareOutstanding ?? null, // in Mio.
    floatShares: null, // Finnhub Free-Tier liefert keinen separaten Float
    insiderPercent: null,
    institutionPercent: null,
    peRatio: m.peBasicExclExtraTTM ?? m.peNormalizedAnnual ?? null,
    eps: m.epsBasicExclExtraItemsTTM ?? m.epsBasicExclExtraItemsAnnual ?? null,
  };
}

/** Firmen-News der letzten `days` Tage. */
async function fetchNews(symbol, { days = 7 } = {}) {
  const token = requireKey();
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const { data } = await client.get('/company-news', {
    params: { symbol, from: fmt(from), to: fmt(to), token },
  });

  return (Array.isArray(data) ? data : []).map((item) => ({
    publishedAt: new Date(item.datetime * 1000).toISOString(),
    headline: item.headline,
    summary: item.summary || null,
    source: item.source || null,
    url: item.url || null,
    category: item.category || null,
  }));
}

function storeFundamentals(db, symbol, f) {
  db.prepare(
    `INSERT INTO fundamentals
       (symbol, date, market_cap, enterprise_value, shares_outstanding, float_shares, insider_percent, institution_percent, pe_ratio, eps)
     VALUES (@symbol, @date, @marketCap, @enterpriseValue, @sharesOutstanding, @floatShares, @insiderPercent, @institutionPercent, @peRatio, @eps)
     ON CONFLICT(symbol, date) DO UPDATE SET
       market_cap = excluded.market_cap, enterprise_value = excluded.enterprise_value,
       shares_outstanding = excluded.shares_outstanding, float_shares = excluded.float_shares,
       insider_percent = excluded.insider_percent, institution_percent = excluded.institution_percent,
       pe_ratio = excluded.pe_ratio, eps = excluded.eps`
  ).run({ symbol, ...f });
  return 1;
}

function storeNews(db, symbol, items) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO news (symbol, published_at, headline, summary, source, url, category)
     VALUES (@symbol, @publishedAt, @headline, @summary, @source, @url, @category)`
  );
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run({ symbol, ...row });
  });
  insertMany(items);
  return items.length;
}

module.exports = { fetchFundamentals, fetchNews, storeFundamentals, storeNews };

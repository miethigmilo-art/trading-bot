const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Leerverkaufsanteil (Short-Float-%) = Short Interest ÷ frei handelbarer Float.
// FINRA liefert nur die absolute Short-Interest-Menge, NICHT den Float — deshalb
// holen wir den Float separat. Quelle: Yahoo quoteSummary (defaultKeyStatistics),
// die einzige hier verfügbare keylose Quelle mit ECHTEM Float (floatShares), nicht
// nur Shares Outstanding. Yahoo verlangt dafür Cookie + Crumb (sonst 401).
//
// WICHTIGE NÄHERUNG: Yahoo liefert den AKTUELLEN Float, nicht den historischen zum
// Zeitpunkt eines alten Squeeze. Für stark verwässernde Penny-Stocks (ständige
// Kapitalerhöhungen) ist der heutige Float oft VIEL größer als damals — der
// berechnete historische Short-Float-% ist dann zu NIEDRIG. Der Wert ist als
// Näherung gekennzeichnet und wird genau daraufhin getestet, ob er TROTZ dieser
// Ungenauigkeit Pump- von echten Short-Squeeze-Fällen trennt. Für die
// Screener-Nutzung (aktuelle Aktien) ist der aktuelle Float dagegen exakt richtig.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_PATH = path.join(__dirname, '..', 'knowledge', 'float_cache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Einmalig Cookie + Crumb besorgen; beides wird für alle Folgeabfragen wiederverwendet. */
async function openSession() {
  const jar = await axios.get('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA },
    timeout: 15000,
    validateStatus: () => true,
  });
  const cookie = (jar.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const { data: crumb } = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
    timeout: 15000,
  });
  if (!crumb || typeof crumb !== 'string') throw new Error('Yahoo-Crumb konnte nicht geholt werden');
  return { cookie, crumb };
}

/** Float + Shares Outstanding für ein Symbol. Gibt null zurück, wenn Yahoo nichts liefert. */
async function fetchFloat(symbol, session) {
  const { data } = await axios.get(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`,
    {
      params: { modules: 'defaultKeyStatistics', crumb: session.crumb },
      headers: { 'User-Agent': UA, Cookie: session.cookie },
      timeout: 15000,
    }
  );
  const k = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
  if (!k) return null;
  const floatShares = k.floatShares?.raw ?? null;
  const sharesOutstanding = k.sharesOutstanding?.raw ?? null;
  if (floatShares == null && sharesOutstanding == null) return null;
  return { floatShares, sharesOutstanding };
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => (a < b ? -1 : 1)));
  fs.writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

/**
 * Holt Float für alle übergebenen Symbole von Yahoo und schreibt sie in den
 * git-getrackten Cache (float_cache.json). Bereits gecachte Symbole werden
 * übersprungen (force überschreibt). So bleibt der Wert offline verfügbar,
 * wenn die DB in einer neuen Session frisch aufgebaut wird.
 */
async function backfillFloat(symbols, { force = false, delayMs = 900 } = {}) {
  const cache = loadCache();
  const session = await openSession();
  const result = { ok: 0, empty: 0, error: 0, skipped: 0 };

  for (const symbol of symbols) {
    if (!force && cache[symbol]) {
      result.skipped++;
      continue;
    }
    try {
      const data = await fetchFloat(symbol, session);
      if (!data) {
        result.empty++;
      } else {
        cache[symbol] = { ...data, fetchedAt: new Date().toISOString().slice(0, 10) };
        result.ok++;
      }
    } catch (err) {
      // 401 => Session abgelaufen, einmal neu öffnen und dasselbe Symbol erneut versuchen.
      if (err.response?.status === 401) {
        try {
          Object.assign(session, await openSession());
          const data = await fetchFloat(symbol, session);
          if (data) {
            cache[symbol] = { ...data, fetchedAt: new Date().toISOString().slice(0, 10) };
            result.ok++;
          } else result.empty++;
        } catch {
          result.error++;
        }
      } else {
        result.error++;
      }
    }
    if (result.ok % 10 === 0 && result.ok > 0) saveCache(cache);
    await sleep(delayMs);
  }

  saveCache(cache);
  return result;
}

/**
 * Berechnet aus dem Cache + den vorhandenen short_interest-Zeilen den
 * approximativen Short-Float-% und schreibt ihn in short_interest.percent_of_float.
 * Läuft komplett offline aus dem Cache — kein Netzwerk nötig, daher Teil des
 * DB-Neuaufbaus. Float wird zusätzlich in fundamentals.float_shares gespiegelt.
 */
function applyPercentOfFloat(db) {
  const cache = loadCache();
  const symbols = Object.keys(cache);
  if (symbols.length === 0) return { symbols: 0, rowsUpdated: 0 };

  const updateSi = db.prepare(
    `UPDATE short_interest SET percent_of_float = @pct
     WHERE symbol = @symbol AND short_interest IS NOT NULL`
  );
  // pro Zeile individuell, weil percent_of_float = short_interest / float je Zeile variiert
  const rowsFor = db.prepare(
    `SELECT id, short_interest FROM short_interest WHERE symbol = ? AND short_interest IS NOT NULL`
  );
  const updateRow = db.prepare(`UPDATE short_interest SET percent_of_float = ? WHERE id = ?`);
  const upsertFloat = db.prepare(
    `INSERT INTO fundamentals (symbol, date, shares_outstanding, float_shares)
     VALUES (@symbol, @date, @sharesOutstanding, @floatShares)
     ON CONFLICT(symbol, date) DO UPDATE SET
       shares_outstanding = COALESCE(excluded.shares_outstanding, fundamentals.shares_outstanding),
       float_shares = COALESCE(excluded.float_shares, fundamentals.float_shares)`
  );

  let rowsUpdated = 0;
  let symbolsUsed = 0;
  const today = new Date().toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    for (const symbol of symbols) {
      const { floatShares, sharesOutstanding } = cache[symbol];
      const denom = floatShares || sharesOutstanding; // Fallback auf Shares Outstanding
      upsertFloat.run({ symbol, date: today, sharesOutstanding: sharesOutstanding ?? null, floatShares: floatShares ?? null });
      if (!denom || denom <= 0) continue;
      symbolsUsed++;
      for (const row of rowsFor.all(symbol)) {
        const pct = (row.short_interest / denom) * 100;
        updateRow.run(pct, row.id);
        rowsUpdated++;
      }
    }
  });
  tx();
  void updateSi; // (Zeilenweises Update oben ist genauer als ein Pauschal-Update)
  return { symbols: symbolsUsed, rowsUpdated };
}

module.exports = { openSession, fetchFloat, backfillFloat, applyPercentOfFloat, loadCache, saveCache, CACHE_PATH };

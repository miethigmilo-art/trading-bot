// Lokale Berechnung von EMA/RVOL direkt aus der `prices`-Tabelle.
// Braucht keinen Alpha-Vantage-Key und kein Rate-Limit — die Rohdaten liegen
// bereits im Data Warehouse (Yahoo-Collector).

function getPriceSeries(db, symbol, { upTo } = {}) {
  const rows = upTo
    ? db.prepare(`SELECT date, close, volume FROM prices WHERE symbol = ? AND date <= ? ORDER BY date ASC`).all(symbol, upTo)
    : db.prepare(`SELECT date, close, volume FROM prices WHERE symbol = ? ORDER BY date ASC`).all(symbol);
  return rows;
}

/** Exponential Moving Average. Erster Wert = SMA der ersten `period` Closes (Standard-Seeding). */
function computeEMA(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;

  const k = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = seed;

  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/** Relative Volume: Volumen am Index i geteilt durch den Durchschnitt der `window` Tage davor. */
function computeRVOL(volumes, index, window = 20) {
  if (index < window) return null;
  const slice = volumes.slice(index - window, index);
  const avg = slice.reduce((a, b) => a + b, 0) / window;
  if (!avg) return null;
  return volumes[index] / avg;
}

/**
 * Berechnet den Feature-Snapshot für JEDEN Handelstag eines Symbols in einem
 * einzigen Durchlauf (statt bei jeder Abfrage die EMA-Serie neu zu berechnen).
 * Wird sowohl für einzelne Trigger-Tage als auch für die Kontrollgruppe
 * (viele "normale" Tage) in der Statistik-Engine genutzt.
 */
function computeSeriesFeatures(rows) {
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const ema100 = computeEMA(closes, 100);
  const ema200 = computeEMA(closes, 200);

  return rows.map((r, idx) => ({
    date: r.date,
    close: closes[idx],
    volume: volumes[idx],
    ema20: ema20[idx],
    ema50: ema50[idx],
    ema100: ema100[idx],
    ema200: ema200[idx],
    emaCrossBullish: ema20[idx] != null && ema50[idx] != null ? ema20[idx] > ema50[idx] : null,
    rvol20: computeRVOL(volumes, idx, 20),
    priceChange5d: idx >= 5 && closes[idx - 5] ? (closes[idx] - closes[idx - 5]) / closes[idx - 5] : null,
  }));
}

/**
 * Feature-Snapshot für ein Symbol an einem bestimmten Datum (oder dem letzten
 * verfügbaren Handelstag davor). Gibt null zurück, wenn keine Kursdaten für
 * das Symbol vorhanden sind.
 */
function featuresAt(db, symbol, date) {
  const series = getPriceSeries(db, symbol, { upTo: date });
  if (series.length === 0) return null;
  const features = computeSeriesFeatures(series);
  return { symbol, ...features[features.length - 1] };
}

module.exports = { getPriceSeries, computeEMA, computeRVOL, computeSeriesFeatures, featuresAt };

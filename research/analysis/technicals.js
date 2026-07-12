// Lokale Berechnung von EMA/RVOL direkt aus der `prices`-Tabelle.
// Braucht keinen Alpha-Vantage-Key und kein Rate-Limit — die Rohdaten liegen
// bereits im Data Warehouse (Yahoo-Collector).

const { computeChartFeatures } = require('./chartPatterns');

/**
 * Liefert SPLIT-BEREINIGTE Kurse: alle OHLC-Werte werden mit dem Faktor
 * adj_close/close des jeweiligen Tages skaliert. Ohne diese Bereinigung
 * erzeugt jeder Reverse-Split einen künstlichen Kurssprung, den der
 * Squeeze-Detektor als "Squeeze" fehlinterpretiert — real passiert bei
 * T2 Biosystems (TTOO): der 1:50-Reverse-Split am 12./13.10.2022 erschien
 * in den Rohdaten als +4454%-Tagesanstieg und landete als vermeintlich
 * verifizierter Fall in der Wissensdatenbank. Kerzenmuster bleiben von der
 * Skalierung unberührt (alle Werte eines Tages werden mit demselben Faktor
 * multipliziert), EMA/RVOL/Breakouts werden über Split-Grenzen konsistent.
 */
function getPriceSeries(db, symbol, { upTo } = {}) {
  const rows = upTo
    ? db.prepare(`SELECT date, open, high, low, close, adj_close, volume FROM prices WHERE symbol = ? AND date <= ? ORDER BY date ASC`).all(symbol, upTo)
    : db.prepare(`SELECT date, open, high, low, close, adj_close, volume FROM prices WHERE symbol = ? ORDER BY date ASC`).all(symbol);

  return rows.map((r) => {
    const factor = r.adj_close != null && r.close ? r.adj_close / r.close : 1;
    return {
      date: r.date,
      open: r.open != null ? r.open * factor : null,
      high: r.high != null ? r.high * factor : null,
      low: r.low != null ? r.low * factor : null,
      close: r.adj_close ?? r.close,
      volume: r.volume,
    };
  });
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
  const chart = computeChartFeatures(rows);

  const priceChange5d = closes.map((c, idx) =>
    idx >= 5 && closes[idx - 5] ? (c - closes[idx - 5]) / closes[idx - 5] : null
  );

  // Kapitulations-Setup: gab es in den letzten 10 Handelstagen (inkl. heute)
  // irgendeinen Tag mit 5-Tage-Rückgang > 10%? Grundlage der Zwei-Stufen-Regel
  // "Kapitulations-Watchlist bilden, auf Zünder warten" (siehe ignition.js).
  const capitulated10d = closes.map((_, idx) => {
    if (idx < 5) return null;
    for (let k = Math.max(5, idx - 9); k <= idx; k++) {
      if (priceChange5d[k] != null && priceChange5d[k] < -0.1) return true;
    }
    return false;
  });

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
    priceChange5d: priceChange5d[idx],
    dailyChange: idx >= 1 && closes[idx - 1] ? (closes[idx] - closes[idx - 1]) / closes[idx - 1] : null,
    capitulated10d: capitulated10d[idx],
    isHammer: chart[idx].isHammer,
    isDoji: chart[idx].isDoji,
    isBullishEngulfing: chart[idx].isBullishEngulfing,
    isShootingStar: chart[idx].isShootingStar,
    breakout20d: chart[idx].breakout20d,
    breakout52w: chart[idx].breakout52w,
    trendStructure: chart[idx].trendStructure,
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

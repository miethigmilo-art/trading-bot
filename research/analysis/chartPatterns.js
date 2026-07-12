// Modul 2 (Chart Engine) — Kerzenmuster, Breakout-Signale und Trendstruktur
// direkt aus OHLC-Daten. Bewusst OHNE geometrische Formationen (Ascending
// Triangle, Cup & Handle etc.) — die brauchen robustes Trendlinien-Fitting,
// das eine eigene, sorgfältig getestete Grundlage bräuchte. Was hier steht,
// ist zuverlässig aus einzelnen Kerzen bzw. Rolling-Fenstern berechenbar.

/** Kerzenmuster für einen einzelnen Tag (braucht open/high/low/close vom Vortag für Engulfing). */
function candlestickPattern(prev, curr) {
  const { open, high, low, close } = curr;
  const range = high - low;
  if (!range || range <= 0) return { isHammer: false, isDoji: false, isBullishEngulfing: false, isShootingStar: false };

  const body = Math.abs(close - open);
  const bodyTop = Math.max(open, close);
  const bodyBottom = Math.min(open, close);
  const upperWick = high - bodyTop;
  const lowerWick = bodyBottom - low;
  const bodyRatio = body / range;

  const isHammer = lowerWick >= 2 * body && upperWick <= 0.1 * range && bodyRatio <= 0.3;
  const isShootingStar = upperWick >= 2 * body && lowerWick <= 0.1 * range && bodyRatio <= 0.3;
  const isDoji = bodyRatio <= 0.1;

  let isBullishEngulfing = false;
  if (prev) {
    const prevBearish = prev.close < prev.open;
    const currBullish = close > open;
    isBullishEngulfing = prevBearish && currBullish && open <= prev.close && close >= prev.open;
  }

  return { isHammer, isDoji, isBullishEngulfing, isShootingStar };
}

/** Breakout: heutiger Schlusskurs über dem höchsten Hoch der letzten `window` Tage davor. */
function rollingMaxBreakout(closes, highs, index, window) {
  if (index < window) return null;
  const priorHigh = Math.max(...highs.slice(index - window, index));
  return closes[index] > priorHigh;
}

/** Swing-Highs/-Lows (lokale Extrema) für die Trendstruktur-Klassifikation. */
function findSwingPoints(closes, halfWindow = 5) {
  const highs = [];
  const lows = [];
  for (let i = halfWindow; i < closes.length - halfWindow; i++) {
    const slice = closes.slice(i - halfWindow, i + halfWindow + 1);
    if (closes[i] === Math.max(...slice)) highs.push(i);
    if (closes[i] === Math.min(...slice)) lows.push(i);
  }
  return { highs, lows };
}

/**
 * Trendstruktur je Tag: 'uptrend' wenn die letzten beiden Swing-Highs UND
 * die letzten beiden Swing-Lows vor diesem Tag jeweils steigen (Higher
 * Highs + Higher Lows), 'downtrend' analog fallend (Lower Highs + Lower
 * Lows), sonst 'mixed'. null, wenn nicht genug Swing-Punkte vorliegen.
 */
function computeTrendStructureSeries(closes, halfWindow = 5) {
  const { highs, lows } = findSwingPoints(closes, halfWindow);
  const result = new Array(closes.length).fill(null);

  for (let i = 0; i < closes.length; i++) {
    const priorHighs = highs.filter((h) => h < i).slice(-2);
    const priorLows = lows.filter((l) => l < i).slice(-2);
    if (priorHighs.length < 2 || priorLows.length < 2) continue;

    const higherHighs = closes[priorHighs[1]] > closes[priorHighs[0]];
    const higherLows = closes[priorLows[1]] > closes[priorLows[0]];
    const lowerHighs = closes[priorHighs[1]] < closes[priorHighs[0]];
    const lowerLows = closes[priorLows[1]] < closes[priorLows[0]];

    if (higherHighs && higherLows) result[i] = 'uptrend';
    else if (lowerHighs && lowerLows) result[i] = 'downtrend';
    else result[i] = 'mixed';
  }
  return result;
}

/**
 * Chart-Feature-Snapshot für jeden Tag einer OHLC-Serie in einem Durchlauf —
 * analog zu computeSeriesFeatures in technicals.js, nur für die
 * Pattern-/Breakout-/Trendstruktur-Signale statt EMA/RVOL.
 */
function computeChartFeatures(rows) {
  const closes = rows.map((r) => r.close);
  const highs = rows.map((r) => r.high);
  const trendStructure = computeTrendStructureSeries(closes);

  return rows.map((r, i) => {
    const candles = candlestickPattern(i > 0 ? rows[i - 1] : null, r);
    return {
      date: r.date,
      ...candles,
      breakout20d: rollingMaxBreakout(closes, highs, i, 20),
      breakout52w: rollingMaxBreakout(closes, highs, i, 252),
      trendStructure: trendStructure[i],
    };
  });
}

module.exports = { candlestickPattern, computeTrendStructureSeries, computeChartFeatures };

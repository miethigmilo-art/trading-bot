// Modul 8 (DNA Engine) — ein Profil pro Aktie über 8 Dimensionen, je 0-10.
// Bewusst ehrlich: Dimensionen ohne echte Daten werden NICHT geraten,
// sondern als null/"keine Daten" markiert. Der Gesamtwert wird nur aus den
// tatsächlich verfügbaren Dimensionen gebildet (z.B. 42/60 bei 6 von 8
// verfügbaren Dimensionen), nicht als falsche /80-Zahl vorgetäuscht.

const { getPriceSeries, computeSeriesFeatures } = require('./technicals');

const DIMENSIONS = ['trend', 'volumen', 'pattern', 'momentum', 'shortInterest', 'float', 'catalyst', 'optionen'];

function scoreTrend(row) {
  if (row.ema20 == null || row.ema50 == null) return null;
  let score = 0;
  if (row.close > row.ema20) score += 1;
  if (row.ema20 > row.ema50) score += 2;
  if (row.ema50 != null && row.ema100 != null && row.ema50 > row.ema100) score += 2;
  if (row.ema100 != null && row.ema200 != null && row.ema100 > row.ema200) score += 2;
  if (row.trendStructure === 'uptrend') score += 3;
  return Math.min(10, score);
}

function scoreVolumen(row) {
  if (row.rvol20 == null) return null;
  if (row.rvol20 >= 5) return 10;
  if (row.rvol20 >= 3) return 8;
  if (row.rvol20 >= 2) return 6;
  if (row.rvol20 >= 1.5) return 4;
  if (row.rvol20 >= 1) return 2;
  return 1;
}

function scorePattern(row) {
  if (row.breakout20d == null && row.breakout52w == null) return null;
  let score = 0;
  if (row.breakout52w) score += 4;
  if (row.breakout20d) score += 3;
  if (row.isBullishEngulfing) score += 2;
  if (row.isHammer) score += 1;
  return Math.min(10, score);
}

function scoreMomentum(row) {
  if (row.priceChange5d == null) return null;
  const pct = row.priceChange5d * 100;
  if (pct >= 50) return 10;
  if (pct >= 25) return 8;
  if (pct >= 10) return 6;
  if (pct >= 0) return 4;
  if (pct >= -10) return 2;
  return 0;
}

function scoreShortInterest(daysToCover) {
  if (daysToCover == null) return null;
  if (daysToCover >= 15) return 10;
  if (daysToCover >= 10) return 8;
  if (daysToCover >= 5) return 6;
  if (daysToCover >= 2) return 4;
  return 2;
}

/** sharesOutstandingMillions: kleinerer Float = höheres Squeeze-Potenzial. */
function scoreFloat(sharesOutstandingMillions) {
  if (sharesOutstandingMillions == null) return null;
  if (sharesOutstandingMillions <= 20) return 10;
  if (sharesOutstandingMillions <= 50) return 8;
  if (sharesOutstandingMillions <= 100) return 6;
  if (sharesOutstandingMillions <= 300) return 4;
  if (sharesOutstandingMillions <= 1000) return 2;
  return 1;
}

function scoreCatalyst(articleCount, avgSentiment) {
  if (articleCount == null) return null;
  let score = Math.min(5, articleCount);
  if (avgSentiment != null && avgSentiment >= 0.15) score += 5;
  else if (avgSentiment != null && avgSentiment > -0.15) score += 2;
  return Math.min(10, score);
}

/**
 * DNA-Profil für ein Symbol am letzten verfügbaren Handelstag. Optionen
 * (Gamma-Exposure/Options-Flow) ist fest null — dafür ist keine Datenquelle
 * angebunden (typischerweise kostenpflichtig, z.B. bei Ortex/CBOE).
 */
function computeDNA(db, symbol) {
  const series = getPriceSeries(db, symbol);
  if (series.length === 0) return null;

  const features = computeSeriesFeatures(series);
  const latest = features[features.length - 1];

  const dtcRow = db
    .prepare(`SELECT days_to_cover FROM short_interest WHERE symbol = ? ORDER BY settlement_date DESC LIMIT 1`)
    .get(symbol);
  const fundRow = db
    .prepare(`SELECT shares_outstanding FROM fundamentals WHERE symbol = ? ORDER BY date DESC LIMIT 1`)
    .get(symbol);
  const newsRow = db
    .prepare(`SELECT article_count, avg_sentiment FROM news_sentiment WHERE symbol = ? ORDER BY date DESC LIMIT 1`)
    .get(symbol);

  const dims = {
    trend: scoreTrend(latest),
    volumen: scoreVolumen(latest),
    pattern: scorePattern(latest),
    momentum: scoreMomentum(latest),
    shortInterest: scoreShortInterest(dtcRow ? dtcRow.days_to_cover : null),
    float: scoreFloat(fundRow ? fundRow.shares_outstanding : null),
    catalyst: scoreCatalyst(newsRow ? newsRow.article_count : null, newsRow ? newsRow.avg_sentiment : null),
    optionen: null, // keine Datenquelle angebunden
  };

  const available = DIMENSIONS.filter((d) => dims[d] != null);
  const total = available.reduce((sum, d) => sum + dims[d], 0);
  const maxPossible = available.length * 10;

  return {
    symbol,
    date: latest.date,
    close: latest.close,
    dims,
    total,
    maxPossible,
    coverage: available.length,
    coverageOf: DIMENSIONS.length,
    ratio: maxPossible ? total / maxPossible : null, // fairer Vergleich zwischen Symbolen mit unterschiedlicher Datenabdeckung
  };
}

/**
 * minCoverage filtert Symbole mit zu wenig bewerteten Dimensionen aus dem
 * Ranking — sonst würde z.B. "1/8 Dimensionen, davon Short Interest=6"
 * (Ratio 0,6) fälschlich vor "5/8 Dimensionen, solide über alle" landen,
 * nur weil eine einzelne Kennzahl zufällig hoch ausfiel.
 */
function computeDNAForSymbols(db, symbols, { minCoverage = 4 } = {}) {
  const all = symbols.map((s) => computeDNA(db, s)).filter(Boolean);
  const ranked = all.filter((p) => p.coverage >= minCoverage).sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
  const excluded = all.filter((p) => p.coverage < minCoverage);
  return { ranked, excluded, minCoverage };
}

const DIM_LABELS = {
  trend: 'Trend',
  volumen: 'Volumen',
  pattern: 'Pattern',
  momentum: 'Momentum',
  shortInterest: 'Short Interest',
  float: 'Float',
  catalyst: 'Catalyst',
  optionen: 'Optionen',
};

function formatDNAReport({ ranked, excluded, minCoverage }) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Modul 8: DNA Engine (${ranked.length} von ${ranked.length + excluded.length} Symbolen im Ranking)`);
  lines.push(
    `Jede Dimension 0-10, nur mit echten Daten bewertet — "—" heißt keine Datenquelle/keine Abdeckung, wird NICHT geschätzt. Ranking nach Anteil (Summe/mögliches Maximum) unter Symbolen mit mindestens ${minCoverage}/8 bewerteten Dimensionen — sonst würde eine einzelne zufällig hohe Kennzahl eine dünne Datenlage überstrahlen.`
  );
  lines.push('');

  for (const p of ranked.slice(0, 20)) {
    const dimStr = DIMENSIONS.map((d) => `${DIM_LABELS[d]} ${p.dims[d] ?? '—'}`).join('  ·  ');
    lines.push(`  ${p.symbol.padEnd(8)} ${p.total}/${p.maxPossible} (${p.coverage}/${p.coverageOf} Dimensionen)  Kurs ${p.close.toFixed(2)} (${p.date})`);
    lines.push(`      ${dimStr}`);
  }

  if (excluded.length) {
    lines.push('');
    lines.push(`Ausgeschlossen (weniger als ${minCoverage}/8 Dimensionen, zu dünne Datenlage fürs Ranking): ${excluded.map((p) => p.symbol).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { computeDNA, computeDNAForSymbols, formatDNAReport, DIMENSIONS, DIM_LABELS };

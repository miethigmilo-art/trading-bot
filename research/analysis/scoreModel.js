// Modul 10: Score-Modell — statt harter UND-Regeln ("RVOL>3 UND DTC>5 UND …")
// eine Logistische Regression über ALLE Features gleichzeitig. Vorteil: ein Fall,
// der 4 von 5 Kriterien erfüllt, fällt nicht mehr komplett durch, sondern bekommt
// eine kalibrierte Wahrscheinlichkeit. Das Modell gewichtet die Features selbst
// und ranked jeden Handelstag — man handelt dann nur die höchstbewerteten.
//
// EHRLICHKEIT: Bewertet wird strikt WALK-FORWARD (out-of-sample). Die Zeitachse
// wird in chronologische Folds geschnitten; jeder Fold wird NUR mit Daten aus
// seiner Vergangenheit trainiert und auf seiner (ungesehenen) Zukunft getestet.
// So kann das Modell sich nicht selbst benoten. Base Rate = Anteil Tage mit
// folgendem Squeeze; der Lift der Top-Perzentile dagegen ist der faire Maßstab.
//
// News-Sentiment (Modul 4) ist BEWUSST NICHT enthalten: die News wurden bevorzugt
// um bekannte Event-Fenster gesammelt, ihre bloße Anwesenheit korreliert daher
// künstlich mit dem Label (Leakage). Erst mit unverzerrter Voll-Abdeckung sinnvoll.

const { getPriceSeries, computeSeriesFeatures } = require('./technicals');
const { loadCache } = require('../collectors/floatData');

// Zwei-Pointer-Ausrichtung einer Settlement-Serie (sortiert) auf Kurstage (sortiert).
function alignStepwise(dates, rows, valueKey) {
  const out = new Array(dates.length).fill(null);
  let si = 0;
  let cur = null;
  for (let i = 0; i < dates.length; i++) {
    while (si < rows.length && rows[si].settlement_date <= dates[i]) {
      cur = rows[si][valueKey];
      si++;
    }
    out[i] = cur;
  }
  return out;
}

// Feature-Definitionen: jede liefert aus dem Tages-Snapshot eine Zahl (oder null).
// null = an diesem Tag nicht messbar → wird später auf den Trainings-Mittelwert
// imputiert (nach Zentrierung Beitrag 0), damit fehlende Kennzahlen nicht raten.
const FEATURES = [
  { name: 'kapitulation_tiefe', fn: (r) => (r.priceChange5d != null ? Math.min(r.priceChange5d, 0) : null) },
  { name: 'rvol_log', fn: (r) => (r.rvol20 != null ? Math.log(1 + Math.max(0, r.rvol20)) : null) },
  { name: 'tagesänderung', fn: (r) => r.dailyChange ?? null },
  { name: 'abstand_ema50', fn: (r) => (r.close != null && r.ema50 ? r.close / r.ema50 - 1 : null) },
  { name: 'abstand_ema200', fn: (r) => (r.close != null && r.ema200 ? r.close / r.ema200 - 1 : null) },
  { name: 'ema20_über_ema50', fn: (r) => (r.emaCrossBullish == null ? null : r.emaCrossBullish ? 1 : 0) },
  { name: 'kapituliert_10d', fn: (r) => (r.capitulated10d == null ? null : r.capitulated10d ? 1 : 0) },
  { name: 'breakout_20d', fn: (r) => (r.breakout20d == null ? null : r.breakout20d ? 1 : 0) },
  { name: 'breakout_52w', fn: (r) => (r.breakout52w == null ? null : r.breakout52w ? 1 : 0) },
  { name: 'trend_up', fn: (r) => (r.trendStructure == null ? null : r.trendStructure === 'uptrend' ? 1 : 0) },
  { name: 'trend_down', fn: (r) => (r.trendStructure == null ? null : r.trendStructure === 'downtrend' ? 1 : 0) },
  { name: 'bullish_engulfing', fn: (r) => (r.isBullishEngulfing == null ? null : r.isBullishEngulfing ? 1 : 0) },
  { name: 'hammer', fn: (r) => (r.isHammer == null ? null : r.isHammer ? 1 : 0) },
  { name: 'days_to_cover_log', fn: (r) => (r.daysToCover != null ? Math.log(1 + Math.max(0, r.daysToCover)) : null) },
  { name: 'short_float_log', fn: (r) => (r.percentOfFloat != null ? Math.log(1 + Math.max(0, r.percentOfFloat)) : null) },
  { name: 'float_klein_log', fn: (r) => (r.floatShares ? -Math.log(r.floatShares) : null) }, // negativ: kleiner Float = höherer Wert
];

/**
 * Baut den Trainingsdatensatz: für jeden Handelstag jedes Symbols einen
 * Feature-Vektor + Label (folgt binnen lookaheadDays ein neuer Squeeze-Start?).
 * Tage innerhalb eines laufenden Squeeze werden übersprungen (wie im Backtest).
 */
function buildDataset(db, { lookaheadDays = 10 } = {}) {
  const eventRows = db.prepare(`SELECT symbol, start_date, end_date FROM squeeze_events ORDER BY symbol, start_date`).all();
  const windowsBySymbol = {};
  for (const r of eventRows) (windowsBySymbol[r.symbol] ||= []).push({ start: r.start_date, end: r.end_date || r.start_date });

  const floatCache = loadCache();
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);

  const samples = [];
  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length < 60) continue;
    const feats = computeSeriesFeatures(series);
    const dates = series.map((r) => r.date);

    const dtcRows = db.prepare(`SELECT settlement_date, days_to_cover FROM short_interest WHERE symbol = ? ORDER BY settlement_date ASC`).all(symbol);
    const pofRows = db.prepare(`SELECT settlement_date, percent_of_float FROM short_interest WHERE symbol = ? AND percent_of_float IS NOT NULL ORDER BY settlement_date ASC`).all(symbol);
    const dtcAligned = alignStepwise(dates, dtcRows, 'days_to_cover');
    const pofAligned = alignStepwise(dates, pofRows, 'percent_of_float');
    const floatShares = floatCache[symbol]?.floatShares || floatCache[symbol]?.sharesOutstanding || null;
    const windows = windowsBySymbol[symbol] || [];

    for (let i = 0; i < series.length; i++) {
      const date = dates[i];
      if (windows.some((w) => date >= w.start && date <= w.end)) continue;
      const futureDates = dates.slice(i + 1, i + 1 + lookaheadDays);
      const last = futureDates[futureDates.length - 1];
      if (!last) continue; // kein volles Lookahead-Fenster mehr → Label unbestimmt
      const label = windows.some((w) => w.start > date && w.start <= last) ? 1 : 0;

      const row = { ...feats[i], daysToCover: dtcAligned[i], percentOfFloat: pofAligned[i], floatShares };
      // Kern-Features müssen vorhanden sein (sonst zu wenig Substanz)
      if (row.priceChange5d == null || row.rvol20 == null || row.ema50 == null) continue;
      const x = FEATURES.map((f) => f.fn(row));
      samples.push({ date, symbol, x, y: label });
    }
  }
  return samples;
}

// ---- Logistische Regression (Batch-Gradientenabstieg, L2, klassengewichtet) ----

function standardizer(samples) {
  const n = FEATURES.length;
  const sum = new Array(n).fill(0);
  const cnt = new Array(n).fill(0);
  for (const s of samples) for (let j = 0; j < n; j++) if (s.x[j] != null) { sum[j] += s.x[j]; cnt[j]++; }
  const mean = sum.map((v, j) => (cnt[j] ? v / cnt[j] : 0));
  const sq = new Array(n).fill(0);
  for (const s of samples) for (let j = 0; j < n; j++) if (s.x[j] != null) sq[j] += (s.x[j] - mean[j]) ** 2;
  const std = sq.map((v, j) => Math.sqrt(cnt[j] ? v / cnt[j] : 1) || 1);
  return { mean, std };
}

// Fehlende Werte → Mittelwert (nach Standardisierung 0). Gibt standardisierten Vektor.
function transform(x, { mean, std }) {
  return x.map((v, j) => (v == null ? 0 : (v - mean[j]) / std[j]));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function trainLogReg(train, norm, { iters = 250, lr = 0.2, lambda = 1.0 } = {}) {
  const n = FEATURES.length;
  const w = new Array(n).fill(0);
  const pos = train.reduce((a, s) => a + s.y, 0);
  const neg = train.length - pos;
  let b = Math.log((pos + 1) / (neg + 1)); // Start-Bias = Log-Odds der Basisrate
  // Klassengewichte: seltene Positive stärker gewichten, sonst sagt das Modell "nie".
  const wPos = neg / (pos + 1);
  const wNeg = 1;
  const X = train.map((s) => transform(s.x, norm));

  for (let it = 0; it < iters; it++) {
    const gw = new Array(n).fill(0);
    let gb = 0;
    let wsum = 0;
    for (let idx = 0; idx < train.length; idx++) {
      const xi = X[idx];
      const yi = train[idx].y;
      let z = b;
      for (let j = 0; j < n; j++) z += w[j] * xi[j];
      const p = sigmoid(z);
      const cw = yi ? wPos : wNeg;
      const err = (p - yi) * cw;
      for (let j = 0; j < n; j++) gw[j] += err * xi[j];
      gb += err;
      wsum += cw;
    }
    for (let j = 0; j < n; j++) w[j] -= lr * (gw[j] / wsum + (lambda * w[j]) / train.length);
    b -= lr * (gb / wsum);
  }
  return { w, b };
}

function predict(model, xStd) {
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * xStd[j];
  return sigmoid(z);
}

/**
 * Walk-Forward-Auswertung: Zeitachse in `folds` chronologische Segmente; Segment k
 * (ab dem 2.) wird NUR mit allen früheren Segmenten trainiert und dann bewertet.
 * Alle Out-of-Sample-Vorhersagen werden gepoolt und nach Score gerankt.
 */
function walkForwardEval(samples, { folds = 5, lookaheadDays = 10 } = {}) {
  const sorted = [...samples].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const foldSize = Math.floor(sorted.length / folds);
  const oos = [];
  for (let k = 1; k < folds; k++) {
    const trainEnd = k * foldSize;
    const testEnd = k === folds - 1 ? sorted.length : (k + 1) * foldSize;
    const train = sorted.slice(0, trainEnd);
    const test = sorted.slice(trainEnd, testEnd);
    if (!train.some((s) => s.y === 1) || test.length === 0) continue;
    const norm = standardizer(train);
    const model = trainLogReg(train, norm);
    for (const s of test) oos.push({ ...s, score: predict(model, transform(s.x, norm)) });
  }
  return oos;
}

// Precision/Recall/Lift, wenn man nur die höchstbewerteten X% aller Tage handelt.
function operatingPoints(oos) {
  const sorted = [...oos].sort((a, b) => b.score - a.score);
  const total = sorted.length;
  const totalPos = sorted.reduce((a, s) => a + s.y, 0);
  const baseRate = totalPos / total;
  const pcts = [0.5, 1, 2, 5, 10, 20];
  return {
    total,
    totalPos,
    baseRatePct: baseRate * 100,
    points: pcts.map((pct) => {
      const cut = Math.max(1, Math.round((pct / 100) * total));
      const top = sorted.slice(0, cut);
      const tp = top.reduce((a, s) => a + s.y, 0);
      const precision = tp / cut;
      return {
        pct,
        signals: cut,
        precisionPct: precision * 100,
        recallPct: totalPos ? (tp / totalPos) * 100 : 0,
        lift: baseRate ? precision / baseRate : null,
      };
    }),
  };
}

// Feature-Gewichte aus einem Modell über ALLE Daten (nur zur Interpretation, nicht
// zur Bewertung) — standardisierte Koeffizienten sind direkt vergleichbar.
function featureWeights(samples) {
  const norm = standardizer(samples);
  const model = trainLogReg(samples, norm);
  return FEATURES.map((f, j) => ({ name: f.name, weight: model.w[j] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

function runScoreModel(db, { lookaheadDays = 10, folds = 5 } = {}) {
  const samples = buildDataset(db, { lookaheadDays });
  const oos = walkForwardEval(samples, { folds, lookaheadDays });
  const op = operatingPoints(oos);
  const weights = featureWeights(samples);
  return { samples: samples.length, positives: samples.reduce((a, s) => a + s.y, 0), oos: oos.length, op, weights, lookaheadDays, folds };
}

const de = (v, d = 1) => (v == null ? 'n/a' : v.toFixed(d).replace('.', ','));

function formatScoreReport(res) {
  const L = [];
  L.push(`PROJECT SQUEEZE — Score-Modell (Logistische Regression, Walk-Forward, Lookahead ${res.lookaheadDays} Tage)`);
  L.push(
    `Datenbasis: ${res.samples.toLocaleString('de-DE')} Handelstag-Vektoren, davon ${res.positives.toLocaleString('de-DE')} mit folgendem Squeeze. Bewertet werden nur die ${res.oos.toLocaleString('de-DE')} OUT-OF-SAMPLE-Vorhersagen (${res.folds} chronologische Folds, Training stets nur auf der Vergangenheit).`
  );
  L.push('');
  L.push(`Basisrate (Zufallstag): ${de(res.op.baseRatePct, 1)}%. Frage: Wenn ich nur die am höchsten bewerteten X% aller Tage handle — wie hoch ist die Trefferquote?`);
  L.push('');
  L.push('  Top-Perzentil │ Signale │ Trefferquote │ Recall │ Lift vs. Basisrate');
  L.push('  ──────────────┼─────────┼──────────────┼────────┼───────────────────');
  for (const p of res.op.points) {
    L.push(
      `  Top ${String(p.pct).replace('.', ',').padStart(4)} %     │ ${String(p.signals).padStart(7)} │   ${de(p.precisionPct, 1).padStart(6)} %   │ ${de(p.recallPct, 0).padStart(4)} % │ ${de(p.lift, 1)}x`
    );
  }
  L.push('');
  L.push('— Feature-Gewichte (standardisiert, |Wert| = Einfluss; + erhöht, − senkt die Squeeze-Wahrscheinlichkeit) —');
  for (const f of res.weights) {
    const bar = '█'.repeat(Math.min(20, Math.round(Math.abs(f.weight) * 8)));
    L.push(`  ${(f.weight >= 0 ? '+' : '−')} ${f.name.padEnd(20)} ${de(Math.abs(f.weight), 2).padStart(5)}  ${bar}`);
  }
  return L.join('\n');
}

module.exports = { runScoreModel, formatScoreReport, buildDataset, walkForwardEval, operatingPoints, FEATURES };

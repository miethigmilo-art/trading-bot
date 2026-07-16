// Zünder-Analyse (Zwei-Stufen-Regel): Die Kapitulations-Regel fängt ~31%
// der echten Anstiege, irrt aber in >90% der Signale. Diese Analyse testet
// gezielt die Hypothese "Setup + Zünder": eine Kapitulation in den letzten
// 10 Handelstagen (Setup) PLUS ein konkretes Aufwach-Signal am heutigen Tag
// (Zünder) — welcher Zünder trennt die explodierenden Kapitulationen von
// denen, die einfach weiterfallen?
//
// Bewusst KEINE Grid-Explosion über den Regelgenerator (das würde tausende
// Kombinationen und Multiple-Testing-Rauschen erzeugen), sondern eine feste,
// vorab formulierte Hypothesenliste — gleiche Walk-Forward-Logik wie
// backtest.js (Tage innerhalb laufender Squeeze-Fenster übersprungen,
// Label = neuer Anstieg beginnt binnen lookaheadDays).

const { getPriceSeries, computeSeriesFeatures } = require('./technicals');

const IGNITION_SIGNALS = [
  { key: 'rvol_gt_2', label: 'RVOL > 2', test: (f) => f.rvol20 != null && f.rvol20 > 2 },
  { key: 'rvol_gt_3', label: 'RVOL > 3', test: (f) => f.rvol20 != null && f.rvol20 > 3 },
  { key: 'green_gt_3', label: 'Grüner Tag > +3%', test: (f) => f.dailyChange != null && f.dailyChange > 0.03 },
  { key: 'green_gt_5', label: 'Grüner Tag > +5%', test: (f) => f.dailyChange != null && f.dailyChange > 0.05 },
  { key: 'green_and_rvol', label: 'Grüner Tag > +3% UND RVOL > 2', test: (f) => f.dailyChange > 0.03 && f.rvol20 != null && f.rvol20 > 2 },
  { key: 'bullish_engulfing', label: 'Bullish Engulfing', test: (f) => f.isBullishEngulfing === true },
  { key: 'hammer', label: 'Hammer', test: (f) => f.isHammer === true },
];

function squeezeWindowsBySymbol(db) {
  const rows = db.prepare(`SELECT symbol, start_date, end_date FROM squeeze_events ORDER BY symbol, start_date`).all();
  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ||= []).push({ start: r.start_date, end: r.end_date || r.start_date });
  return bySymbol;
}

function runIgnitionTest(db, { lookaheadDays = 10 } = {}) {
  const windowsBySymbol = squeezeWindowsBySymbol(db);
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);

  // Zähler: Setup allein, jeder Zünder allein, Setup+Zünder
  const mk = () => ({ tp: 0, fp: 0, fn: 0 });
  const setupOnly = mk();
  const signalOnly = Object.fromEntries(IGNITION_SIGNALS.map((s) => [s.key, mk()]));
  const combined = Object.fromEntries(IGNITION_SIGNALS.map((s) => [s.key, mk()]));
  let totalDays = 0;
  let totalPositives = 0;

  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length < 25) continue;
    const features = computeSeriesFeatures(series);
    const dates = series.map((r) => r.date);
    const windows = windowsBySymbol[symbol] || [];

    for (let i = 0; i < series.length; i++) {
      const date = dates[i];
      if (windows.some((w) => date >= w.start && date <= w.end)) continue;

      const futureDates = dates.slice(i + 1, i + 1 + lookaheadDays);
      const lastFuture = futureDates[futureDates.length - 1];
      if (!lastFuture) continue;
      const label = windows.some((w) => w.start > date && w.start <= lastFuture);

      const f = features[i];
      if (f.capitulated10d == null) continue;
      totalDays += 1;
      if (label) totalPositives += 1;

      const setup = f.capitulated10d === true;
      if (setup && label) setupOnly.tp += 1;
      else if (setup) setupOnly.fp += 1;
      else if (label) setupOnly.fn += 1;

      for (const sig of IGNITION_SIGNALS) {
        const fires = sig.test(f);
        const both = setup && fires;
        const s1 = signalOnly[sig.key];
        if (fires && label) s1.tp += 1;
        else if (fires) s1.fp += 1;
        else if (label) s1.fn += 1;
        const c = combined[sig.key];
        if (both && label) c.tp += 1;
        else if (both) c.fp += 1;
        else if (label) c.fn += 1;
      }
    }
  }

  const stats = (m) => {
    const signals = m.tp + m.fp;
    const positives = m.tp + m.fn;
    return {
      signals,
      precisionPct: signals ? (m.tp / signals) * 100 : null,
      recallPct: positives ? (m.tp / positives) * 100 : null,
    };
  };

  return {
    baseRatePct: totalDays ? (totalPositives / totalDays) * 100 : null,
    setupOnly: stats(setupOnly),
    rows: IGNITION_SIGNALS.map((sig) => ({
      label: sig.label,
      alone: stats(signalOnly[sig.key]),
      withSetup: stats(combined[sig.key]),
    })),
  };
}

const fmt = (v, digits = 1) => (v == null ? 'n/a' : v.toFixed(digits).replace('.', ','));

function formatIgnitionReport(result, { lookaheadDays }) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Zünder-Analyse (Setup: Kapitulation in den letzten 10 Tagen · Lookahead ${lookaheadDays} Tage)`);
  lines.push(`Basisrate: ${fmt(result.baseRatePct, 2)}% · Setup allein: ${fmt(result.setupOnly.precisionPct)}% Trefferquote bei ${fmt(result.setupOnly.recallPct, 0)}% Recall (${result.setupOnly.signals.toLocaleString('de-DE')} Signale)`);
  lines.push('Frage: welcher Zünder macht aus der breiten Kapitulations-Watchlist ein präziseres Signal?');
  lines.push('');
  lines.push('  Zünder                                  allein                      MIT Kapitulations-Setup');
  for (const r of result.rows) {
    const a = `${fmt(r.alone.precisionPct)}% @ ${fmt(r.alone.recallPct, 0)}% Recall`;
    const w = `${fmt(r.withSetup.precisionPct)}% @ ${fmt(r.withSetup.recallPct, 0)}% Recall (n=${r.withSetup.signals.toLocaleString('de-DE')})`;
    lines.push(`  ${r.label.padEnd(38)} ${a.padEnd(27)} ${w}`);
  }
  return lines.join('\n');
}

module.exports = { runIgnitionTest, formatIgnitionReport, IGNITION_SIGNALS };

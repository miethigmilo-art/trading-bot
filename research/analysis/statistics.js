const { getPriceSeries, computeSeriesFeatures, featuresAt } = require('./technicals');

function getSqueezeEvents(db) {
  return db.prepare(`SELECT symbol, event_name, start_date, end_date, metrics_at_trigger FROM squeeze_events`).all();
}

function buildSqueezeFeatureSet(db, events) {
  const dtcStmt = db.prepare(
    `SELECT days_to_cover FROM short_interest WHERE symbol = ? AND settlement_date <= ? ORDER BY settlement_date DESC LIMIT 1`
  );
  return events.map((ev) => {
    const tech = featuresAt(db, ev.symbol, ev.start_date); // null, wenn keine Kursdaten vorliegen (z.B. SPRT, delistet)
    const manual = ev.metrics_at_trigger ? JSON.parse(ev.metrics_at_trigger) : {};
    const dtcRow = dtcStmt.get(ev.symbol, ev.start_date);
    return {
      symbol: ev.symbol,
      eventName: ev.event_name,
      date: ev.start_date,
      // RVOL: bevorzugt aus den eigenen Kursdaten berechnet, sonst der in
      // events.json manuell erfasste Näherungswert (z.B. SPRT ohne Kurshistorie).
      rvol20: tech?.rvol20 ?? (typeof manual.rvol === 'number' ? manual.rvol : null),
      emaCrossBullish: tech?.emaCrossBullish ?? null,
      daysToCover: dtcRow ? dtcRow.days_to_cover : null,
      isHammer: tech?.isHammer ?? null,
      isDoji: tech?.isDoji ?? null,
      isBullishEngulfing: tech?.isBullishEngulfing ?? null,
      isShootingStar: tech?.isShootingStar ?? null,
      breakout20d: tech?.breakout20d ?? null,
      breakout52w: tech?.breakout52w ?? null,
      trendStructure: tech?.trendStructure ?? null,
      priceChange5d: tech?.priceChange5d ?? null,
    };
  });
}

/**
 * Kontrollgruppe: alle Handelstage aller beobachteten Symbole, AUSSER den
 * Tagen rund um (±10 Tage) die erfassten Squeeze-Events selbst. Das ist eine
 * grobe Annäherung an "normale Aktientage" — kein sauber gezogenes Sample,
 * aber ausreichend für einen ersten Prototyp der Statistik-Engine.
 */
function buildControlFeatureSet(db, events) {
  const windowsBySymbol = {};
  for (const ev of events) {
    const start = new Date(ev.start_date);
    start.setDate(start.getDate() - 10);
    const end = new Date(ev.end_date || ev.start_date);
    end.setDate(end.getDate() + 10);
    (windowsBySymbol[ev.symbol] ||= []).push([start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
  }

  const dtcStmt = db.prepare(
    `SELECT days_to_cover FROM short_interest WHERE symbol = ? AND settlement_date <= ? ORDER BY settlement_date DESC LIMIT 1`
  );
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);

  const control = [];
  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length === 0) continue;
    const features = computeSeriesFeatures(series);
    const excludeWindows = windowsBySymbol[symbol] || [];

    for (const f of features) {
      const inExcludedWindow = excludeWindows.some(([s, e]) => f.date >= s && f.date <= e);
      if (inExcludedWindow) continue;
      const dtcRow = dtcStmt.get(symbol, f.date);
      control.push({
        symbol,
        date: f.date,
        rvol20: f.rvol20,
        emaCrossBullish: f.emaCrossBullish,
        daysToCover: dtcRow ? dtcRow.days_to_cover : null,
        isHammer: f.isHammer,
        isDoji: f.isDoji,
        isBullishEngulfing: f.isBullishEngulfing,
        isShootingStar: f.isShootingStar,
        breakout20d: f.breakout20d,
        breakout52w: f.breakout52w,
        trendStructure: f.trendStructure,
        priceChange5d: f.priceChange5d,
      });
    }
  }
  return control;
}

function frequency(rows, check) {
  const applicable = rows.filter((r) => check.value(r) != null);
  const hits = applicable.filter((r) => check.test(r));
  return {
    n: applicable.length,
    hit: hits.length,
    pct: applicable.length ? (hits.length / applicable.length) * 100 : null,
  };
}

const FEATURE_CHECKS = [
  { name: 'RVOL > 3', value: (r) => r.rvol20, test: (r) => r.rvol20 > 3 },
  { name: 'RVOL > 5', value: (r) => r.rvol20, test: (r) => r.rvol20 > 5 },
  { name: 'EMA20 > EMA50 (bullischer Trend)', value: (r) => r.emaCrossBullish, test: (r) => r.emaCrossBullish === true },
  { name: 'Days to Cover > 5', value: (r) => r.daysToCover, test: (r) => r.daysToCover > 5 },
  { name: 'Days to Cover > 10', value: (r) => r.daysToCover, test: (r) => r.daysToCover > 10 },
];

/**
 * Modul 6 — vergleicht, wie oft ein Feature bei bekannten Squeeze-Trigger-Tagen
 * zutrifft vs. bei "normalen" Handelstagen der Watchlist. Bei nur einer
 * Handvoll erfasster Fälle (siehe squeeze_events) sind das erste Signale für
 * die Regel-Entwicklung (Modul 7), keine statistisch belastbaren Aussagen.
 */
function runStatistics(db) {
  const events = getSqueezeEvents(db);
  const squeezeSet = buildSqueezeFeatureSet(db, events);
  const controlSet = buildControlFeatureSet(db, events);

  const rows = FEATURE_CHECKS.map((check) => ({
    feature: check.name,
    squeeze: frequency(squeezeSet, check),
    control: frequency(controlSet, check),
  }));

  return { events: squeezeSet, controlCount: controlSet.length, rows };
}

function formatReport(report) {
  const lines = [];
  lines.push(
    `PROJECT SQUEEZE — Modul 6: Statistik  (${report.events.length} Squeeze-Fälle vs. ${report.controlCount} Kontroll-Handelstage)`
  );
  lines.push(
    report.events.length < 30
      ? 'Hinweis: Stichprobe ist noch sehr klein — Prozentwerte sind ein Prototyp der Methode, keine belastbare Statistik. Aussagekraft wächst mit jedem weiteren Fall in Modul 9.'
      : 'Hinweis: Die meisten Fälle stammen aus dem automatischen Squeeze-Detektor (reines Kursmuster: schneller Anstieg + starker Fall danach), nicht aus geprüften Short-Squeeze-Storys — darunter können auch Pump-and-Dumps, Earnings-Spikes o.ä. mit ähnlicher Kursform sein. Zahlen sind ein Signal, keine belastbare Kausalaussage.'
  );
  lines.push('');
  for (const r of report.rows) {
    const sq = r.squeeze.pct != null ? `${r.squeeze.pct.toFixed(0)}% (${r.squeeze.hit}/${r.squeeze.n})` : 'n/a';
    const ct = r.control.pct != null ? `${r.control.pct.toFixed(0)}% (${r.control.hit}/${r.control.n})` : 'n/a';
    lines.push(`  ${r.feature.padEnd(36)} Squeeze: ${sq.padEnd(16)} Normal: ${ct}`);
  }
  return lines.join('\n');
}

module.exports = { runStatistics, formatReport, buildSqueezeFeatureSet, buildControlFeatureSet };

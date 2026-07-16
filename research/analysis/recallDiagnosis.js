// Recall-Diagnose: Der Backtest zeigt, dass unsere Regeln fast keinen der
// Anstiege IM VORAUS erkennen (Recall ~0-4%). Diese Analyse misst, wie die
// Tage unmittelbar VOR einem erfassten Squeeze-Start tatsächlich aussehen —
// über alle kuratierten Fälle — und vergleicht mit normalen Handelstagen.
// Hypothese (aus der SL-Analyse): die Vorphase ist ein Abwärtstrend
// (Median -13% in den 10 Tagen vor start_date), unsere bullischen Signale
// KÖNNEN dort gar nicht feuern.

const { getPriceSeries, computeSeriesFeatures } = require('./technicals');

function alignDaysToCover(dates, settlementRows) {
  const result = new Array(dates.length).fill(null);
  let si = 0;
  let current = null;
  for (let i = 0; i < dates.length; i++) {
    while (si < settlementRows.length && settlementRows[si].settlement_date <= dates[i]) {
      current = settlementRows[si].days_to_cover;
      si++;
    }
    result[i] = current;
  }
  return result;
}

/**
 * Feature-Zustand am Handelstag VOR dem Squeeze-Start (start_date - 1) für
 * jeden kuratierten Fall, plus Fenster-Aggregate (max. RVOL der 5 Tage davor).
 */
function collectPreEventStates(db) {
  const events = db
    .prepare(
      `SELECT symbol, event_name, start_date FROM squeeze_events
       WHERE detection_method IN ('manual', 'verified') ORDER BY start_date`
    )
    .all();

  const states = [];
  for (const ev of events) {
    const series = getPriceSeries(db, ev.symbol);
    if (series.length < 30) continue;
    const dates = series.map((r) => r.date);
    const startIdx = dates.indexOf(ev.start_date);
    if (startIdx < 6) continue; // braucht Vorlauf für Fenster-Aggregate

    const features = computeSeriesFeatures(series);
    const dayBefore = features[startIdx - 1];
    const dtcRows = db
      .prepare(`SELECT settlement_date, days_to_cover FROM short_interest WHERE symbol = ? ORDER BY settlement_date ASC`)
      .all(ev.symbol);
    const dtc = alignDaysToCover(dates, dtcRows)[startIdx - 1];

    const window = features.slice(startIdx - 5, startIdx);
    const maxRvol5d = Math.max(...window.map((f) => f.rvol20 ?? -1));

    states.push({
      symbol: ev.symbol,
      eventName: ev.event_name,
      trendStructure: dayBefore.trendStructure,
      rvol20: dayBefore.rvol20,
      maxRvol5d: maxRvol5d >= 0 ? maxRvol5d : null,
      priceChange5d: dayBefore.priceChange5d,
      emaCrossBullish: dayBefore.emaCrossBullish,
      breakout20d: dayBefore.breakout20d,
      daysToCover: dtc,
    });
  }
  return states;
}

function pct(hits, n) {
  return n ? `${((hits / n) * 100).toFixed(0)}% (${hits}/${n})` : 'n/a';
}

function formatPreEventReport(states, controlRows) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Recall-Diagnose: der Handelstag VOR dem Squeeze-Start (${states.length} kuratierte Fälle)`);
  lines.push(
    'Misst, wie die unmittelbare Vorphase echter Fälle aussah — im Vergleich zu normalen Handelstagen. Erklärt, warum bullische Regeln (Uptrend/Breakout) fast keinen Fall im Voraus erkennen können.'
  );
  lines.push('');

  const checks = [
    { label: 'Trendstruktur: Downtrend (LH+LL)', ev: (s) => s.trendStructure === 'downtrend', ctrl: (c) => c.trendStructure === 'downtrend', has: (x) => x.trendStructure != null },
    { label: 'Trendstruktur: Uptrend (HH+HL)', ev: (s) => s.trendStructure === 'uptrend', ctrl: (c) => c.trendStructure === 'uptrend', has: (x) => x.trendStructure != null },
    { label: '5-Tage-Rückgang > 10%', ev: (s) => s.priceChange5d < -0.1, ctrl: (c) => c.priceChange5d < -0.1, has: (x) => x.priceChange5d != null },
    { label: 'Dry Volume (RVOL < 0.7)', ev: (s) => s.rvol20 < 0.7, ctrl: (c) => c.rvol20 < 0.7, has: (x) => x.rvol20 != null },
    { label: 'RVOL > 2 (Volumen zieht schon an)', ev: (s) => s.rvol20 > 2, ctrl: (c) => c.rvol20 > 2, has: (x) => x.rvol20 != null },
    { label: 'Max-RVOL der 5 Vortage > 2', ev: (s) => s.maxRvol5d > 2, ctrl: () => false, has: (x) => x.maxRvol5d != null, noCtrl: true },
    { label: 'EMA20 > EMA50 (bullisch)', ev: (s) => s.emaCrossBullish === true, ctrl: (c) => c.emaCrossBullish === true, has: (x) => x.emaCrossBullish != null },
    { label: 'Days to Cover > 5', ev: (s) => s.daysToCover > 5, ctrl: (c) => c.daysToCover > 5, has: (x) => x.daysToCover != null },
  ];

  for (const check of checks) {
    const evApplicable = states.filter((s) => check.has(s));
    const evHits = evApplicable.filter(check.ev).length;
    let ctrlStr = '—';
    if (!check.noCtrl) {
      const ctrlApplicable = controlRows.filter((c) => check.has(c));
      const ctrlHits = ctrlApplicable.filter(check.ctrl).length;
      ctrlStr = pct(ctrlHits, ctrlApplicable.length);
    }
    lines.push(`  ${check.label.padEnd(38)} Vortag echter Fälle: ${pct(evHits, evApplicable.length).padEnd(16)} Normale Tage: ${ctrlStr}`);
  }
  return lines.join('\n');
}

module.exports = { collectPreEventStates, formatPreEventReport };

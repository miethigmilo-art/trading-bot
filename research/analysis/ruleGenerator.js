const { buildSqueezeFeatureSet, buildControlFeatureSet } = require('./statistics');

function getSqueezeEvents(db) {
  return db.prepare(`SELECT symbol, event_name, start_date, end_date, metrics_at_trigger FROM squeeze_events`).all();
}

// Ein Merkmal darf pro Regel höchstens einmal vorkommen (RVOL>3 UND RVOL>5
// wäre redundant) — deshalb sind die Varianten je Feature gruppiert.
const PREDICATE_GROUPS = {
  rvol: [
    { key: 'rvol_gt_3', label: 'RVOL > 3', value: (r) => r.rvol20, test: (r) => r.rvol20 > 3 },
    { key: 'rvol_gt_5', label: 'RVOL > 5', value: (r) => r.rvol20, test: (r) => r.rvol20 > 5 },
    // "Dry Volume" aus der ursprünglichen Modul-2-Liste: die Ruhe vor dem
    // Sturm — Recall-Diagnose zeigte, dass die Vorphase echter Fälle oft
    // durch Abwärtstrend + austrocknendes Volumen geprägt ist.
    { key: 'rvol_lt_0_7', label: 'Dry Volume (RVOL < 0.7)', value: (r) => r.rvol20, test: (r) => r.rvol20 < 0.7 },
  ],
  emaCross: [
    { key: 'ema20_gt_ema50', label: 'EMA20 > EMA50', value: (r) => r.emaCrossBullish, test: (r) => r.emaCrossBullish === true },
  ],
  daysToCover: [
    { key: 'dtc_gt_5', label: 'Days to Cover > 5', value: (r) => r.daysToCover, test: (r) => r.daysToCover > 5 },
    { key: 'dtc_gt_10', label: 'Days to Cover > 10', value: (r) => r.daysToCover, test: (r) => r.daysToCover > 10 },
  ],
  // Modul 2 (Chart Engine): Breakout, Trendstruktur, Kerzenmuster — siehe chartPatterns.js
  breakout: [
    { key: 'breakout_20d', label: '20-Tage-Breakout', value: (r) => r.breakout20d, test: (r) => r.breakout20d === true },
    { key: 'breakout_52w', label: '52-Wochen-Breakout', value: (r) => r.breakout52w, test: (r) => r.breakout52w === true },
  ],
  trend: [
    { key: 'trend_uptrend', label: 'Trendstruktur: Uptrend (HH+HL)', value: (r) => r.trendStructure, test: (r) => r.trendStructure === 'uptrend' },
    { key: 'trend_downtrend', label: 'Trendstruktur: Downtrend (LH+LL)', value: (r) => r.trendStructure, test: (r) => r.trendStructure === 'downtrend' },
  ],
  momentum: [
    { key: 'down5d_gt_10', label: '5-Tage-Rückgang > 10% (Kapitulation)', value: (r) => r.priceChange5d, test: (r) => r.priceChange5d < -0.1 },
  ],
  candlestick: [
    { key: 'bullish_engulfing', label: 'Bullish Engulfing', value: (r) => r.isBullishEngulfing, test: (r) => r.isBullishEngulfing === true },
    { key: 'hammer', label: 'Hammer', value: (r) => r.isHammer, test: (r) => r.isHammer === true },
  ],
};

// Erzeugt alle Kombinationen, die aus jeder Feature-Gruppe höchstens eine
// Variante ziehen (inkl. "keine"), ohne die leere Kombination.
function generateCombinations() {
  const groupNames = Object.keys(PREDICATE_GROUPS);
  let combos = [[]];
  for (const group of groupNames) {
    const variants = [null, ...PREDICATE_GROUPS[group]];
    const next = [];
    for (const combo of combos) {
      for (const variant of variants) {
        next.push(variant ? [...combo, variant] : combo);
      }
    }
    combos = next;
  }
  return combos.filter((c) => c.length > 0);
}

function evaluateRule(predicates, rows) {
  const applicable = rows.filter((r) => predicates.every((p) => p.value(r) != null));
  const hits = applicable.filter((r) => predicates.every((p) => p.test(r)));
  return { applicable: applicable.length, hits: hits.length };
}

/**
 * Modul 7 — testet systematisch Kombinationen der in Modul 6 verfügbaren
 * Features gegen bekannte Squeeze-Fälle vs. Kontrollgruppe und bewertet sie
 * per Lift (wie viel häufiger die Bedingung bei Squeezes zutrifft als sonst).
 * Die meisten Fälle in squeeze_events sind automatisch aus reinen
 * Kursmustern erkannt (kein geprüfter Short-Squeeze-Auslöser) — das ist ein
 * Kandidaten-Ranking für weitere Forschung, keine belastbare Trefferquote
 * fürs Trading.
 */
function generateRules(db) {
  const events = getSqueezeEvents(db);
  const squeezeSet = buildSqueezeFeatureSet(db, events);
  const controlSet = buildControlFeatureSet(db, events);

  const rules = generateCombinations().map((predicates) => {
    const squeeze = evaluateRule(predicates, squeezeSet);
    const control = evaluateRule(predicates, controlSet);
    const squeezeRate = squeeze.applicable ? squeeze.hits / squeeze.applicable : null;
    const controlRate = control.applicable ? control.hits / control.applicable : null;
    let lift = null;
    if (squeezeRate != null && controlRate != null) {
      lift = controlRate > 0 ? squeezeRate / controlRate : squeeze.hits > 0 ? Infinity : null;
    }
    return {
      label: predicates.map((p) => p.label).join(' UND '),
      conditions: predicates.map((p) => p.key),
      squeezeHits: squeeze.hits,
      squeezeApplicable: squeeze.applicable,
      controlHits: control.hits,
      controlApplicable: control.applicable,
      lift,
    };
  });

  // Nur Regeln, die mindestens einen bekannten Fall tatsächlich erkennen, sind
  // als Kandidat interessant — alles andere ist reines Rauschen.
  return rules
    .filter((r) => r.squeezeHits > 0)
    .sort((a, b) => {
      const liftA = a.lift === Infinity ? Number.MAX_VALUE : a.lift ?? -1;
      const liftB = b.lift === Infinity ? Number.MAX_VALUE : b.lift ?? -1;
      if (liftB !== liftA) return liftB - liftA;
      if (b.squeezeHits !== a.squeezeHits) return b.squeezeHits - a.squeezeHits;
      return a.conditions.length - b.conditions.length;
    });
}

function storeRules(db, rules) {
  const insert = db.prepare(
    `INSERT INTO rules (label, conditions, squeeze_hits, squeeze_applicable, control_hits, control_applicable, lift)
     VALUES (@label, @conditions, @squeezeHits, @squeezeApplicable, @controlHits, @controlApplicable, @lift)
     ON CONFLICT(conditions) DO UPDATE SET
       label = excluded.label, squeeze_hits = excluded.squeeze_hits, squeeze_applicable = excluded.squeeze_applicable,
       control_hits = excluded.control_hits, control_applicable = excluded.control_applicable,
       lift = excluded.lift, generated_at = datetime('now')`
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      insert.run({
        ...r,
        conditions: JSON.stringify(r.conditions),
        lift: r.lift === Infinity ? 999999 : r.lift, // SQLite kennt kein Infinity; als Sentinel-Wert ablegen
      });
    }
  });
  insertMany(rules);
  return rules.length;
}

function formatRulesReport(rules) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Modul 7: Regelgenerator (${rules.length} Kandidaten mit mindestens einem Treffer)`);
  lines.push(
    'Hinweis: Lift = wie viel häufiger die Bedingung bei Squeeze-Fällen zutrifft als an normalen Handelstagen. Die meisten Fälle stammen aus dem automatischen Detektor (reines Kursmuster, kein geprüfter Short-Squeeze-Auslöser) — Kandidaten für weitere Forschung, keine Trading-Signale.'
  );
  lines.push('');
  rules.slice(0, 15).forEach((r, i) => {
    const sq = `${r.squeezeHits}/${r.squeezeApplicable}`;
    const ct = r.controlApplicable ? `${((r.controlHits / r.controlApplicable) * 100).toFixed(0)}% (${r.controlHits}/${r.controlApplicable})` : 'n/a';
    const liftLabel = r.lift === Infinity ? '∞ (nie im Kontrollset)' : r.lift != null ? `${r.lift.toFixed(1)}x` : 'n/a';
    lines.push(`  ${String(i + 1).padStart(2)}. ${r.label.padEnd(38)} Squeeze-Treffer: ${sq.padEnd(6)} Fehlalarm: ${ct.padEnd(20)} Lift: ${liftLabel}`);
  });
  return lines.join('\n');
}

module.exports = { generateRules, storeRules, formatRulesReport, PREDICATE_GROUPS, generateCombinations };

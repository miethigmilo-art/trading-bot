const { getPriceSeries, computeSeriesFeatures } = require('./technicals');
const { generateCombinations } = require('./ruleGenerator');

/**
 * Lädt die aus dem Backtest bekannten Regeln als aktive Scan-Regeln — nur
 * solche mit belastbarer Signalzahl UND einer Trefferquote, die die
 * Basisrate (Zufallsniveau) deutlich schlägt (minLiftFactor). Ohne den
 * zweiten Filter würden häufig feuernde, aber kaum besser als der Zufall
 * treffende Regeln (z.B. 4% bei 4% Basisrate) die wirklich selektiven
 * Signale im Score überdecken.
 */
function loadActiveRules(db, { lookaheadDays = 10, minSignals = 15, minLiftFactor = 1.5 } = {}) {
  const rows = db
    .prepare(
      `SELECT label, conditions, precision_pct, base_rate_pct, true_positives + false_positives AS signals
       FROM backtest_results
       WHERE lookahead_days = ?
         AND (true_positives + false_positives) >= ?
         AND precision_pct IS NOT NULL
         AND precision_pct >= base_rate_pct * ?
       ORDER BY precision_pct DESC`
    )
    .all(lookaheadDays, minSignals, minLiftFactor);

  const combos = generateCombinations();
  return rows
    .map((r) => {
      const conditions = JSON.parse(r.conditions);
      const predicates = combos.find((c) => JSON.stringify(c.map((p) => p.key)) === JSON.stringify(conditions));
      return predicates ? { label: r.label, precisionPct: r.precision_pct, signals: r.signals, predicates } : null;
    })
    .filter(Boolean);
}

/**
 * Wendet alle aktiven Regeln auf den letzten verfügbaren Handelstag eines
 * Symbols an. Score = höchste Trefferquote (aus dem Backtest) unter den
 * Regeln, die HEUTE zutreffen — 0, wenn keine Regel feuert. Bewusst simpel
 * und nachvollziehbar (Max statt z.B. eine gewichtete Summe mehrerer
 * überlappender Regeln, die sich sonst gegenseitig aufblähen würden).
 */
function scoreSymbol(db, symbol, rules, dtcStmt) {
  const series = getPriceSeries(db, symbol);
  if (series.length === 0) return null;

  const features = computeSeriesFeatures(series);
  const latest = features[features.length - 1];
  const dtcRow = dtcStmt.get(symbol);
  const row = { ...latest, daysToCover: dtcRow ? dtcRow.days_to_cover : null };

  const matched = rules.filter(
    (rule) => rule.predicates.every((p) => p.value(row) != null) && rule.predicates.every((p) => p.test(row))
  );
  const score = matched.length ? Math.max(...matched.map((r) => r.precisionPct)) : 0;

  return {
    symbol,
    date: latest.date,
    close: latest.close,
    score,
    matchedRules: matched.map((r) => ({ label: r.label, precisionPct: r.precisionPct, signals: r.signals })),
  };
}

/**
 * Scannt eine Liste von Symbolen und liefert eine nach Score sortierte
 * Rangliste. Reine Berechnung auf bereits vorhandenen Kursdaten — kein
 * zusätzlicher API-Call, braucht aber frische Daten (node research/cli.js
 * run) für aussagekräftige "aktuelle" Ergebnisse.
 */
function scanSymbols(db, symbols, options = {}) {
  const rules = loadActiveRules(db, options);
  const dtcStmt = db.prepare(
    `SELECT days_to_cover FROM short_interest WHERE symbol = ? ORDER BY settlement_date DESC LIMIT 1`
  );
  const results = symbols.map((s) => scoreSymbol(db, s, rules, dtcStmt)).filter(Boolean);
  return { rules, results: results.sort((a, b) => b.score - a.score) };
}

function formatScanReport({ rules, results }) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Squeeze Score Scanner (${rules.length} aktive Regeln, ${results.length} Symbole gescannt)`);
  lines.push(
    'Score = höchste historische Trefferquote unter den Regeln, die HEUTE zutreffen. Basis: Backtest über die Wissensdatenbank — Vorhersage, keine Garantie, Stichproben teils klein (siehe risk:analyze für Details je Regel).'
  );
  lines.push('');

  const hits = results.filter((r) => r.score > 0);
  if (hits.length === 0) {
    lines.push('Keine der gescannten Symbole erfüllt aktuell eine der aktiven Regeln.');
    return lines.join('\n');
  }

  for (const r of hits.slice(0, 20)) {
    const priceStr = r.close < 1 ? r.close.toFixed(4) : r.close.toFixed(2);
    lines.push(`  ${r.symbol.padEnd(8)} Score: ${r.score.toFixed(0)}%  Kurs: ${priceStr} (${r.date})`);
    for (const m of r.matchedRules) {
      lines.push(`      → ${m.label} (Trefferquote ${m.precisionPct.toFixed(0)}%, n=${m.signals})`);
    }
  }
  return lines.join('\n');
}

module.exports = { loadActiveRules, scoreSymbol, scanSymbols, formatScanReport };

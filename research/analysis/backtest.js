const { getPriceSeries, computeSeriesFeatures } = require('./technicals');
const { generateCombinations } = require('./ruleGenerator');

function squeezeWindowsBySymbol(db) {
  const rows = db.prepare(`SELECT symbol, start_date, end_date FROM squeeze_events ORDER BY symbol, start_date`).all();
  const bySymbol = {};
  for (const r of rows) {
    (bySymbol[r.symbol] ||= []).push({ start: r.start_date, end: r.end_date || r.start_date });
  }
  return bySymbol;
}

/** Days-to-Cover pro Kurstag ausrichten (Two-Pointer-Sweep, beide Listen sortiert). */
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
 * Backtesting Engine — der Unterschied zu Modul 6/7 (Lift am bereits
 * bekannten Trigger-Tag): hier wird JEDER Handelstag jedes Symbols
 * durchlaufen und geprüft, ob eine Regel an diesem Tag feuert UND ob
 * innerhalb der nächsten `lookaheadDays` Handelstage tatsächlich ein neuer
 * Squeeze beginnt. Daraus ergibt sich eine echte Precision ("Trefferquote":
 * wenn die Regel feuert, wie oft folgt wirklich ein Squeeze) statt nur einer
 * relativen Häufigkeit.
 *
 * Tage INNERHALB eines bereits laufenden Squeeze-Fensters werden übersprungen
 * — wir testen, ob die Regel den EINSTIEG in einen neuen Squeeze erkennt,
 * nicht ob sie während eines laufenden Squeeze "bullisch" aussieht.
 */
function runBacktest(db, { lookaheadDays = 10, fromDate = null, toDate = null } = {}) {
  const windowsBySymbol = squeezeWindowsBySymbol(db);
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);
  const combos = generateCombinations();

  const agg = combos.map((predicates) => ({
    label: predicates.map((p) => p.label).join(' UND '),
    conditions: predicates.map((p) => p.key),
    predicates,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
  }));

  let totalDaysEvaluated = 0;
  let totalPositiveLabels = 0;

  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length < 25) continue; // zu wenig Historie für sinnvolle Features

    const features = computeSeriesFeatures(series);
    const dates = series.map((r) => r.date);
    const dtcRows = db
      .prepare(`SELECT settlement_date, days_to_cover FROM short_interest WHERE symbol = ? ORDER BY settlement_date ASC`)
      .all(symbol);
    const dtcAligned = alignDaysToCover(dates, dtcRows);
    const windows = windowsBySymbol[symbol] || [];

    for (let i = 0; i < series.length; i++) {
      const date = dates[i];
      if (fromDate && date < fromDate) continue; // Zeitraum-Filter für die Universalitäts-Validierung
      if (toDate && date > toDate) continue;
      const insideSqueeze = windows.some((w) => date >= w.start && date <= w.end);
      if (insideSqueeze) continue;

      const futureDates = dates.slice(i + 1, i + 1 + lookaheadDays);
      const lastFutureDate = futureDates[futureDates.length - 1];
      const label = lastFutureDate ? windows.some((w) => w.start > date && w.start <= lastFutureDate) : false;

      const row = { ...features[i], daysToCover: dtcAligned[i] };
      totalDaysEvaluated += 1;
      if (label) totalPositiveLabels += 1;

      for (const rule of agg) {
        if (!rule.predicates.every((p) => p.value(row) != null)) continue; // Kennzahl an diesem Tag nicht verfügbar
        const fires = rule.predicates.every((p) => p.test(row));
        if (fires && label) rule.tp += 1;
        else if (fires && !label) rule.fp += 1;
        else if (!fires && label) rule.fn += 1;
        else rule.tn += 1;
      }
    }
  }

  const baseRatePct = totalDaysEvaluated ? (totalPositiveLabels / totalDaysEvaluated) * 100 : null;

  return agg.map((r) => {
    const fires = r.tp + r.fp;
    const actualPositives = r.tp + r.fn;
    return {
      label: r.label,
      conditions: r.conditions,
      tp: r.tp,
      fp: r.fp,
      fn: r.fn,
      tn: r.tn,
      precisionPct: fires ? (r.tp / fires) * 100 : null,
      recallPct: actualPositives ? (r.tp / actualPositives) * 100 : null,
      baseRatePct,
    };
  });
}

function storeBacktestResults(db, results, lookaheadDays) {
  const insert = db.prepare(
    `INSERT INTO backtest_results (
       label, conditions, lookahead_days, true_positives, false_positives, false_negatives, true_negatives,
       precision_pct, recall_pct, base_rate_pct
     ) VALUES (@label, @conditions, @lookaheadDays, @tp, @fp, @fn, @tn, @precisionPct, @recallPct, @baseRatePct)
     ON CONFLICT(conditions, lookahead_days) DO UPDATE SET
       label = excluded.label, true_positives = excluded.true_positives, false_positives = excluded.false_positives,
       false_negatives = excluded.false_negatives, true_negatives = excluded.true_negatives,
       precision_pct = excluded.precision_pct, recall_pct = excluded.recall_pct, base_rate_pct = excluded.base_rate_pct,
       run_at = datetime('now')`
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run({ ...r, conditions: JSON.stringify(r.conditions), lookaheadDays });
  });
  insertMany(results);
  return results.length;
}

const MIN_SIGNALS = 5; // Mindestzahl an Feuer-Signalen, damit eine Precision überhaupt aussagekräftig ist

function formatBacktestReport(results, { lookaheadDays }) {
  const lines = [];
  const baseRate = results[0]?.baseRatePct;
  lines.push(`PROJECT SQUEEZE — Backtesting Engine (Lookahead: ${lookaheadDays} Handelstage)`);
  lines.push(
    `Basisrate: An ${baseRate?.toFixed(2)}% aller bewerteten Tage folgte überhaupt irgendein neuer Squeeze-Start binnen ${lookaheadDays} Handelstagen — das ist der Vergleichsmaßstab, gegen den die Trefferquote unten zu lesen ist.`
  );
  lines.push(
    'Trefferquote (Precision) = wenn die Regel feuert, wie oft folgte wirklich ein Squeeze. Recall = wie viel % aller echten Squeezes hätte die Regel erkannt. Nur Regeln mit >=5 Signalen gelistet.'
  );
  lines.push('');

  const ranked = results
    .filter((r) => r.tp + r.fp >= MIN_SIGNALS)
    .sort((a, b) => (b.precisionPct ?? -1) - (a.precisionPct ?? -1));

  if (ranked.length === 0) {
    lines.push(`  Keine Regel erreichte im Backtest-Zeitraum >=${MIN_SIGNALS} Signale.`);
    return lines.join('\n');
  }

  ranked.slice(0, 15).forEach((r, i) => {
    const fires = r.tp + r.fp;
    const recall = r.recallPct != null ? `${r.recallPct.toFixed(0)}%` : 'n/a';
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${r.label.padEnd(38)} Trefferquote: ${r.precisionPct.toFixed(0)}% (${r.tp}/${fires})  Recall: ${recall}  Signale: ${fires}`
    );
  });
  return lines.join('\n');
}

module.exports = { runBacktest, storeBacktestResults, formatBacktestReport };

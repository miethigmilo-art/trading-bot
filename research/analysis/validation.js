// Universalitäts-Validierung: Eine Regel verdient das Etikett "universell"
// nur, wenn sie in GETRENNTEN Zeiträumen unabhängig funktioniert — nicht nur
// über den Gesamtzeitraum gemittelt. Sonst könnte z.B. die gesamte
// Trefferquote aus der Meme-Ära 2021 stammen und die Regel wäre außerhalb
// dieses Regimes wertlos. Testet die Kernregeln getrennt je Ära und
// vergleicht die Trefferquote relativ zur jeweiligen Basisrate (der Lift ist
// die faire Vergleichsgröße, weil die Basisrate selbst je Ära schwankt).

const { runBacktest } = require('./backtest');

// Ären mit unterschiedlichem Marktregime — bewusst grob geschnitten:
// Meme-Ära (inkl. GME/AMC-Phase), Bärenmarkt/Normalisierung, KI/Quantum-Ära.
const ERAS = [
  { name: 'bis Ende 2021 (Meme-Ära)', from: null, to: '2021-12-31' },
  { name: '2022–2023 (Bärenmarkt)', from: '2022-01-01', to: '2023-12-31' },
  { name: '2024+ (KI/Quantum-Ära)', from: '2024-01-01', to: null },
];

// Die Kernregeln aus screener-rules.md — vorab fixiert, kein Nachjustieren
// je Ära (das wäre Overfitting durch die Hintertür).
const CORE_RULES = [
  ['down5d_gt_10'],
  ['trend_downtrend', 'down5d_gt_10'],
  ['dtc_gt_5', 'down5d_gt_10'],
  ['rvol_gt_5', 'breakout_20d', 'trend_uptrend'],
  ['dtc_gt_10', 'breakout_52w', 'trend_uptrend'],
];

function runValidation(db, { lookaheadDays = 10 } = {}) {
  const eras = ERAS.map((era) => {
    const results = runBacktest(db, { lookaheadDays, fromDate: era.from, toDate: era.to });
    const byConditions = new Map(results.map((r) => [JSON.stringify(r.conditions), r]));
    const baseRatePct = results[0]?.baseRatePct ?? null;
    return {
      name: era.name,
      baseRatePct,
      rules: CORE_RULES.map((conditions) => {
        const r = byConditions.get(JSON.stringify(conditions));
        if (!r) return { conditions, missing: true };
        return {
          label: r.label,
          precisionPct: r.precisionPct,
          recallPct: r.recallPct,
          signals: r.tp + r.fp,
          lift: r.precisionPct != null && baseRatePct ? r.precisionPct / baseRatePct : null,
        };
      }),
    };
  });
  return eras;
}

const fmt = (v, d = 1) => (v == null ? 'n/a' : v.toFixed(d).replace('.', ','));

function formatValidationReport(eras, { lookaheadDays }) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Universalitäts-Validierung (Lookahead ${lookaheadDays} Tage)`);
  lines.push(
    'Kernregeln getrennt je Marktregime getestet. Maßstab ist der LIFT (Trefferquote ÷ Basisrate der jeweiligen Ära) — eine universelle Regel hält Lift > 1 in JEDER Ära, nicht nur im Durchschnitt.'
  );
  for (const era of eras) {
    lines.push('');
    lines.push(`— ${era.name} · Basisrate ${fmt(era.baseRatePct, 2)}% —`);
    for (const r of era.rules) {
      if (r.missing) {
        lines.push(`  (Regel ${JSON.stringify(r.conditions)} nicht gefunden)`);
        continue;
      }
      const liftLabel = r.lift != null ? `${fmt(r.lift)}x` : 'n/a';
      const flag = r.lift != null && r.lift >= 1.2 ? '✓' : r.lift != null && r.lift >= 1.0 ? '~' : '✗';
      lines.push(
        `  ${flag} ${r.label.padEnd(52)} ${fmt(r.precisionPct)}% @ ${fmt(r.recallPct, 0)}% Recall  (n=${r.signals.toLocaleString('de-DE')})  Lift ${liftLabel}`
      );
    }
  }
  lines.push('');
  lines.push('✓ = Lift ≥ 1,2 in dieser Ära · ~ = knapp über Basisrate · ✗ = unter Basisrate (Regel versagt in diesem Regime)');
  return lines.join('\n');
}

module.exports = { runValidation, formatValidationReport, ERAS, CORE_RULES };

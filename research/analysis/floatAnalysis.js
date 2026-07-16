// Trennt der Short-Float-% (Leerverkaufsanteil) echte Short-Squeezes von reinen
// Pumps? Hypothese: Ein hoher Leerverkaufsanteil ist der TREIBSTOFF eines echten
// Short-Squeeze (Shorts müssen zurückkaufen). Ein reiner Pump/Hype dagegen läuft
// auch OHNE hohe Shorts (Retail-Momentum, News). Wenn die Zahl etwas taugt,
// sollten Fälle mit hohem Short-Float im Schnitt anders aussehen als solche mit
// niedrigem — z.B. steilere/heftigere Anstiege.
//
// NÄHERUNG: percent_of_float basiert auf dem HEUTIGEN Float (Yahoo), nicht dem
// historischen. Für verwässernde Penny-Stocks ist der historische Wert oft höher
// als hier berechnet. Deshalb ist das hier ein Trenn-TEST, keine exakte Messung.

// Kleinste settlement-Zeile mit percent_of_float am oder vor dem Start des Anstiegs.
function shortFloatAtStart(db, symbol, startDate) {
  return db
    .prepare(
      `SELECT percent_of_float FROM short_interest
       WHERE symbol = ? AND settlement_date <= ? AND percent_of_float IS NOT NULL
       ORDER BY settlement_date DESC LIMIT 1`
    )
    .get(symbol, startDate)?.percent_of_float ?? null;
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Pearson-Korrelation zwischen Short-Float-% und Anstieg — grobe Richtungsangabe.
function correlation(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const sx = pairs.reduce((a, [x]) => a + x, 0);
  const sy = pairs.reduce((a, [, y]) => a + y, 0);
  const sxx = pairs.reduce((a, [x]) => a + x * x, 0);
  const syy = pairs.reduce((a, [, y]) => a + y * y, 0);
  const sxy = pairs.reduce((a, [x, y]) => a + x * y, 0);
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return denom === 0 ? null : (n * sxy - sx * sy) / denom;
}

const BUCKETS = [
  { name: '< 5 %  (kaum Shorts → eher Pump)', lo: 0, hi: 5 },
  { name: '5–10 %', lo: 5, hi: 10 },
  { name: '10–20 %', lo: 10, hi: 20 },
  { name: '20–40 %', lo: 20, hi: 40 },
  { name: '≥ 40 %  (extrem → klassischer Squeeze)', lo: 40, hi: Infinity },
];

function runFloatAnalysis(db) {
  const events = db
    .prepare(
      `SELECT symbol, event_name, start_date, gain_percent, drop_percent, rise_duration_days, detection_method
       FROM squeeze_events
       WHERE detection_method IN ('manual', 'verified')
         AND gain_percent IS NOT NULL AND start_date IS NOT NULL`
    )
    .all();

  const withFloat = [];
  let noFloat = 0;
  for (const ev of events) {
    const sf = shortFloatAtStart(db, ev.symbol, ev.start_date);
    if (sf == null) {
      noFloat++;
      continue;
    }
    withFloat.push({ ...ev, shortFloat: sf });
  }

  const buckets = BUCKETS.map((b) => {
    const rows = withFloat.filter((r) => r.shortFloat >= b.lo && r.shortFloat < b.hi);
    return {
      name: b.name,
      count: rows.length,
      medianGain: median(rows.map((r) => r.gain_percent)),
      medianDrop: median(rows.map((r) => r.drop_percent).filter((v) => v != null)),
      medianRise: median(rows.map((r) => r.rise_duration_days).filter((v) => v != null)),
    };
  });

  const corr = correlation(withFloat.map((r) => [r.shortFloat, r.gain_percent]));
  // Short-Float > 100 % ist real unmöglich → reines Näherungs-Artefakt: der HEUTIGE
  // Float ist (nach Reverse-Split / Aktienrückgang) kleiner als der historische
  // Short Interest. Zählt, wie viele Fälle davon betroffen sind.
  const implausible = withFloat.filter((r) => r.shortFloat > 100).length;

  return {
    totalEvents: events.length,
    covered: withFloat.length,
    noFloat,
    implausible,
    buckets,
    correlation: corr,
    medianShortFloat: median(withFloat.map((r) => r.shortFloat)),
    top: [...withFloat].sort((a, b) => b.shortFloat - a.shortFloat).slice(0, 12),
  };
}

const pct = (v, d = 1) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(d).replace('.', ',')}`);
const num = (v, d = 1) => (v == null ? 'n/a' : v.toFixed(d).replace('.', ','));

function formatFloatReport(a) {
  const L = [];
  L.push('PROJECT SQUEEZE — Leerverkaufsanteil (Short-Float-%) als Trennmerkmal');
  L.push(
    'Frage: Trennt der Short-Float-% echte Short-Squeezes von reinen Pumps? Datenbasis: kuratierte Fälle (manual/verified) mit bekanntem Anstieg.'
  );
  L.push('⚠ NÄHERUNG: Float = HEUTIGER Yahoo-Float, nicht historisch. Für verwässernde Penny-Stocks zu niedrig. Als Trenn-Test lesen, nicht als exakte Zahl.');
  L.push('');
  L.push(`Abdeckung: ${a.covered} von ${a.totalEvents} Fällen mit Float-Wert (${a.noFloat} ohne — meist delisted/fusioniert/ausländisch).`);
  L.push(`Median Short-Float-% über alle abgedeckten Fälle: ${num(a.medianShortFloat)} %`);
  if (a.implausible > 0) {
    L.push(
      `Davon ${a.implausible} Fälle mit rechnerisch > 100 % — real unmöglich, reines Näherungs-Artefakt (heutiger Float durch Reverse-Split/Aktienrückgang kleiner als der damalige Short Interest). Bestätigt die Dilution-Warnung.`
    );
  }
  L.push('');
  L.push('— Anstieg nach Short-Float-Klasse (Median) —');
  for (const b of a.buckets) {
    if (b.count === 0) {
      L.push(`  ${b.name.padEnd(40)} n=0`);
      continue;
    }
    L.push(
      `  ${b.name.padEnd(40)} n=${String(b.count).padStart(3)}  Anstieg ${pct(b.medianGain, 0).padStart(6)} %  Fall ${pct(b.medianDrop, 0).padStart(6)} %  Dauer ${num(b.medianRise, 0)} T`
    );
  }
  L.push('');
  const c = a.correlation;
  const verdict =
    c == null
      ? 'zu wenige Fälle für eine Aussage'
      : Math.abs(c) < 0.15
      ? 'praktisch KEIN Zusammenhang — der Short-Float-% trennt die Anstiegshöhe nicht (die Kapitulations-Regel bleibt der bessere Filter)'
      : c > 0
      ? 'schwacher POSITIVER Zusammenhang — höherer Short-Float ging tendenziell mit größerem Anstieg einher'
      : 'schwacher NEGATIVER Zusammenhang — überraschend, höherer Short-Float ging mit kleinerem Anstieg einher';
  L.push(`Korrelation Short-Float-% ↔ Anstieg: r = ${c == null ? 'n/a' : c.toFixed(2).replace('.', ',')}  → ${verdict}`);
  L.push('');
  L.push('— Fälle mit dem höchsten Short-Float-% (Näherung) —');
  for (const t of a.top) {
    L.push(`  ${t.symbol.padEnd(6)} ${num(t.shortFloat).padStart(6)} %  Anstieg ${pct(t.gain_percent, 0)} %  · ${t.event_name}`);
  }
  return L.join('\n');
}

module.exports = { runFloatAnalysis, formatFloatReport, shortFloatAtStart };

const { getPriceSeries, featuresAt } = require('./technicals');

/** Swing-Highs: Index j ist ein lokales Maximum, wenn kein Schlusskurs in [j-halfWindow, j+halfWindow] höher ist. */
function findLocalMaxima(closes, halfWindow) {
  const maxima = [];
  for (let j = halfWindow; j < closes.length - halfWindow; j++) {
    let isMax = true;
    for (let k = j - halfWindow; k <= j + halfWindow; k++) {
      if (closes[k] > closes[j]) {
        isMax = false;
        break;
      }
    }
    if (isMax) maxima.push(j);
  }
  return maxima;
}

/** Benachbarte Swing-Highs (innerhalb cooldownDays) zu einem Peak zusammenfassen — sonst zählt ein Plateau mehrfach. */
function dedupePeaks(closes, maxima, cooldownDays) {
  const sorted = [...maxima].sort((a, b) => a - b);
  const result = [];
  for (const idx of sorted) {
    const last = result[result.length - 1];
    if (last != null && idx - last <= cooldownDays) {
      if (closes[idx] > closes[last]) result[result.length - 1] = idx;
    } else {
      result.push(idx);
    }
  }
  return result;
}

function troughBefore(closes, j, maxRiseDays) {
  const start = Math.max(0, j - maxRiseDays);
  let minIdx = start;
  for (let k = start; k <= j; k++) if (closes[k] < closes[minIdx]) minIdx = k;
  return minIdx;
}

/** Erster Tag nach dem Peak, an dem der Drawdown die Schwelle erreicht — sonst der tiefste Punkt im Fenster. */
function findRetracementEnd(closes, j, maxDropWindow, dropThreshold) {
  const end = Math.min(closes.length - 1, j + maxDropWindow);
  let minIdx = j;
  for (let k = j; k <= end; k++) {
    if (closes[k] < closes[minIdx]) minIdx = k;
    if ((closes[j] - closes[k]) / closes[j] >= dropThreshold) return k;
  }
  return minIdx;
}

const DEFAULT_OPTIONS = {
  riseThreshold: 0.8, // mind. 80% Anstieg vom Tief zum Peak
  maxRiseDays: 40, // ...innerhalb von max. 40 Handelstagen (~2 Monate)
  dropThreshold: 0.3, // mind. 30% Fall vom Peak danach — trennt Squeeze-Kollaps von normalem Aufwärtstrend
  maxDropWindow: 40, // ...innerhalb von max. 40 Handelstagen nach dem Peak
  peakHalfWindow: 10, // Swing-High: höchster Schlusskurs in einem Fenster von +-10 Handelstagen
  cooldownDays: 20, // benachbarte Peaks in diesem Abstand gelten als derselbe Fall
};

/**
 * Rein preisbasierte Squeeze-Erkennung: sucht Tief-zu-Hoch-Anstiege über einer
 * Schwelle in kurzer Zeit, gefolgt von einem deutlichen Fall danach — das
 * Kursmuster, das (fast) jeden Short-Squeeze-artigen Fall auszeichnet,
 * unabhängig vom tatsächlichen Auslöser. Liefert damit KEINE geprüfte
 * Auslöser-Story, dafür beliebig skalierbar über viele Symbole.
 */
/**
 * Reverse-Split-Artefakt-Schutz: Yahoos Kursdaten sind an manchen
 * Split-Grenzen NICHT bereinigt (auch adj_close nicht — real beobachtet bei
 * T2 Biosystems, 1:50-Split am 12./13.10.2022, erschien als +4454%-Sprung).
 * Fingerabdruck eines Split-Artefakts: ein einzelner extremer
 * Übernacht-Sprung (>3x) bei gleichzeitig UNTERDURCHSCHNITTLICHEM Volumen
 * (die Stückzahl wird ja durch den Split-Faktor geteilt). Ein echter
 * Squeeze-Tag hat das Gegenteil: explodierendes Volumen.
 */
function hasSuspectedSplitArtifact(closes, volumes, i, j) {
  let maxRatio = 1;
  let maxK = -1;
  for (let k = i + 1; k <= j; k++) {
    const ratio = closes[k - 1] > 0 ? closes[k] / closes[k - 1] : 1;
    if (ratio > maxRatio) {
      maxRatio = ratio;
      maxK = k;
    }
  }
  if (maxRatio <= 3) return false;

  const start = Math.max(0, maxK - 20);
  const priorVols = volumes.slice(start, maxK).filter((v) => v != null);
  if (priorVols.length === 0) return false;
  const avgVol = priorVols.reduce((a, b) => a + b, 0) / priorVols.length;
  return volumes[maxK] != null && volumes[maxK] < avgVol;
}

function detectSqueezeEvents(rows, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (rows.length < 2 * opts.peakHalfWindow + 1) return [];

  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const peaks = dedupePeaks(closes, findLocalMaxima(closes, opts.peakHalfWindow), opts.cooldownDays);

  const candidates = [];
  for (const j of peaks) {
    const i = troughBefore(closes, j, opts.maxRiseDays);
    if (i >= j) continue;
    const gain = (closes[j] - closes[i]) / closes[i];
    if (gain < opts.riseThreshold) continue;

    const k = findRetracementEnd(closes, j, opts.maxDropWindow, opts.dropThreshold);
    const drop = (closes[j] - closes[k]) / closes[j];
    if (drop < opts.dropThreshold) continue;

    if (hasSuspectedSplitArtifact(closes, volumes, i, j)) continue;

    candidates.push({
      startDate: rows[i].date,
      peakDate: rows[j].date,
      endDate: rows[k].date,
      priceBefore: closes[i],
      pricePeak: closes[j],
      priceAfter: closes[k],
      gainPercent: gain * 100,
      dropPercent: drop * 100,
      riseDurationDays: j - i,
      dropDurationDays: k - j,
    });
  }
  return candidates;
}

function overlapsExisting(candidate, existingWindows) {
  return existingWindows.some(([s, e]) => candidate.startDate <= e && candidate.endDate >= s);
}

/**
 * Scannt alle Symbole mit Kurshistorie in der DB und fügt neue Kandidaten als
 * squeeze_events (detection_method='auto') ein — Fälle, deren Zeitfenster
 * sich mit einem bereits erfassten Fall desselben Symbols überschneiden
 * (egal ob manuell oder zuvor automatisch erkannt), werden übersprungen.
 */
function scanAllSymbols(db, options = {}) {
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);
  const existingStmt = db.prepare(`SELECT start_date, end_date FROM squeeze_events WHERE symbol = ?`);
  const insert = db.prepare(
    `INSERT INTO squeeze_events (
       symbol, event_name, detection_method, start_date, peak_date, end_date,
       metrics_at_trigger, price_before, price_peak, gain_percent, rise_duration_days,
       price_after, drop_percent, drop_duration_days, source, notes
     ) VALUES (
       @symbol, @eventName, 'auto', @startDate, @peakDate, @endDate,
       @metricsAtTrigger, @priceBefore, @pricePeak, @gainPercent, @riseDurationDays,
       @priceAfter, @dropPercent, @dropDurationDays, @source, @notes
     )
     ON CONFLICT(symbol, event_name) DO NOTHING`
  );

  let scanned = 0;
  let inserted = 0;
  const bySymbol = {};

  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length === 0) continue;
    scanned += 1;

    const existingWindows = existingStmt.all(symbol).map((r) => [r.start_date, r.end_date || r.start_date]);
    const candidates = detectSqueezeEvents(series, options).filter((c) => !overlapsExisting(c, existingWindows));

    let countForSymbol = 0;
    for (const c of candidates) {
      const tech = featuresAt(db, symbol, c.startDate);
      const eventName = `${symbol} Squeeze ${c.startDate} (auto)`;
      insert.run({
        symbol,
        eventName,
        startDate: c.startDate,
        peakDate: c.peakDate,
        endDate: c.endDate,
        metricsAtTrigger: JSON.stringify({ rvol: tech?.rvol20 ?? null, emaCrossBullish: tech?.emaCrossBullish ?? null }),
        priceBefore: c.priceBefore,
        pricePeak: c.pricePeak,
        gainPercent: c.gainPercent,
        riseDurationDays: c.riseDurationDays,
        priceAfter: c.priceAfter,
        dropPercent: c.dropPercent,
        dropDurationDays: c.dropDurationDays,
        source: 'Automatisch erkannt aus Kursverlauf (research/analysis/squeezeDetector.js) — kein geprüfter Auslöser, nur Preismuster.',
        notes: `Erkennungsparameter: Anstieg >=${Math.round((options.riseThreshold ?? DEFAULT_OPTIONS.riseThreshold) * 100)}% binnen <=${options.maxRiseDays ?? DEFAULT_OPTIONS.maxRiseDays} Handelstagen, danach Fall >=${Math.round((options.dropThreshold ?? DEFAULT_OPTIONS.dropThreshold) * 100)}%.`,
      });
      inserted += 1;
      countForSymbol += 1;
      existingWindows.push([c.startDate, c.endDate]); // verhindert Überlappung innerhalb desselben Laufs
    }
    if (countForSymbol > 0) bySymbol[symbol] = countForSymbol;
  }

  return { scanned, inserted, bySymbol };
}

module.exports = { detectSqueezeEvents, scanAllSymbols, DEFAULT_OPTIONS };

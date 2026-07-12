const { getPriceSeries, computeSeriesFeatures } = require('./technicals');
const { generateCombinations } = require('./ruleGenerator');

function squeezeWindowsBySymbol(db) {
  const rows = db.prepare(`SELECT symbol, start_date, peak_date, end_date FROM squeeze_events ORDER BY symbol, start_date`).all();
  const bySymbol = {};
  for (const r of rows) {
    (bySymbol[r.symbol] ||= []).push({
      start: r.start_date,
      peak: r.peak_date || r.start_date,
      end: r.end_date || r.peak_date || r.start_date,
    });
  }
  return bySymbol;
}

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

function findRuleByConditions(conditions) {
  const combos = generateCombinations();
  const match = combos.find((predicates) => JSON.stringify(predicates.map((p) => p.key)) === JSON.stringify(conditions));
  if (!match) throw new Error(`Regel mit conditions=${JSON.stringify(conditions)} nicht gefunden`);
  return match;
}

/**
 * Risikoprofil einer Regel: für jeden Tag, an dem die Regel feuert UND
 * danach tatsächlich (binnen lookaheadDays) ein Squeeze folgt (echte
 * Treffer aus dem Backtest — siehe backtest.js), wird der Kursverlauf
 * zwischen Entry-Tag und Squeeze-Beginn untersucht: Wie tief fällt der Kurs
 * nach dem Einstieg noch, bevor der eigentliche Squeeze einsetzt (Maximum
 * Adverse Excursion), und wie viele Handelstage dauert das? Das ist die
 * Datengrundlage für eine Stop-Loss-Kalibrierung: ein zu enger SL stoppt
 * genau die Fälle aus, die man eigentlich erwischen wollte.
 */
function analyzeRiskProfile(db, conditions, { lookaheadDays = 10, maxHoldDays = 30 } = {}) {
  const predicates = findRuleByConditions(conditions);
  const windowsBySymbol = squeezeWindowsBySymbol(db);
  const symbols = db.prepare(`SELECT DISTINCT symbol FROM prices`).all().map((r) => r.symbol);
  const entries = [];

  for (const symbol of symbols) {
    const series = getPriceSeries(db, symbol);
    if (series.length < 25) continue;

    const features = computeSeriesFeatures(series);
    const dates = series.map((r) => r.date);
    const closes = series.map((r) => r.close);
    const dtcRows = db
      .prepare(`SELECT settlement_date, days_to_cover FROM short_interest WHERE symbol = ? ORDER BY settlement_date ASC`)
      .all(symbol);
    const dtcAligned = alignDaysToCover(dates, dtcRows);
    const windows = windowsBySymbol[symbol] || [];

    for (let i = 0; i < series.length; i++) {
      const date = dates[i];
      const insideSqueeze = windows.some((w) => date >= w.start && date <= w.end);
      if (insideSqueeze) continue;

      const row = { ...features[i], daysToCover: dtcAligned[i] };
      if (!predicates.every((p) => p.value(row) != null)) continue;
      if (!predicates.every((p) => p.test(row))) continue; // Regel feuert an diesem Tag nicht

      const futureDates = dates.slice(i + 1, i + 1 + lookaheadDays);
      const lastFutureDate = futureDates[futureDates.length - 1];
      if (!lastFutureDate) continue;
      const matchedWindow = windows.find((w) => w.start > date && w.start <= lastFutureDate);
      if (!matchedWindow) continue; // Fehlalarm — für das Risikoprofil nicht relevant, das braucht echte Treffer

      const squeezeStartIdx = dates.indexOf(matchedWindow.start);
      const endIdx = Math.min(i + maxHoldDays, squeezeStartIdx >= 0 ? squeezeStartIdx : i + maxHoldDays, series.length - 1);

      let minClose = closes[i];
      let minIdx = i;
      for (let k = i; k <= endIdx; k++) {
        if (closes[k] < minClose) {
          minClose = closes[k];
          minIdx = k;
        }
      }

      // Take-Profit-Seite: höchster Schlusskurs zwischen Entry und dem
      // tatsächlichen Peak des Squeeze (mit etwas Spielraum via maxHoldDays,
      // falls peak_date fehlt/vor dem Entry liegt).
      const peakIdx = dates.indexOf(matchedWindow.peak);
      const gainSearchEnd = Math.max(endIdx, peakIdx >= i ? Math.min(peakIdx, i + maxHoldDays, series.length - 1) : endIdx);
      let maxClose = closes[i];
      let maxIdx = i;
      for (let k = i; k <= gainSearchEnd; k++) {
        if (closes[k] > maxClose) {
          maxClose = closes[k];
          maxIdx = k;
        }
      }

      const entryClose = closes[i];
      entries.push({
        symbol,
        entryDate: date,
        squeezeStartDate: matchedWindow.start,
        drawdownPct: ((minClose - entryClose) / entryClose) * 100,
        daysToWorst: minIdx - i,
        daysToSqueezeStart: squeezeStartIdx >= 0 ? squeezeStartIdx - i : null,
        gainPct: ((maxClose - entryClose) / entryClose) * 100,
        daysToPeak: maxIdx - i,
      });
    }
  }

  return entries;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function summarizeRiskProfile(entries) {
  if (entries.length === 0) return { n: 0 };
  const drawdowns = entries.map((e) => e.drawdownPct).sort((a, b) => a - b); // aufsteigend, negativste zuerst
  const daysToWorst = entries.map((e) => e.daysToWorst).sort((a, b) => a - b);
  const daysToSqueeze = entries.map((e) => e.daysToSqueezeStart).filter((d) => d != null).sort((a, b) => a - b);
  const gains = entries.map((e) => e.gainPct).sort((a, b) => a - b); // aufsteigend, kleinste Gewinne zuerst
  const daysToPeak = entries.map((e) => e.daysToPeak).sort((a, b) => a - b);

  return {
    n: entries.length,
    maxDrawdownPct: drawdowns[0],
    p90DrawdownPct: percentile(drawdowns, 10), // die schlechtesten 10% liegen jenseits davon
    medianDrawdownPct: percentile(drawdowns, 50),
    medianDaysToWorst: percentile(daysToWorst, 50),
    medianDaysToSqueezeStart: percentile(daysToSqueeze, 50),
    maxDaysToSqueezeStart: daysToSqueeze[daysToSqueeze.length - 1] ?? null,
    // Take-Profit-Seite: p10GainPct = die schwächsten 10% der echten Treffer
    // erreichten NICHT mehr als diesen Gewinn — ein TP darüber hätte diese
    // Fälle verpasst (zu spät verkauft bzw. gar nicht erst ausgelöst).
    minGainPct: gains[0],
    p10GainPct: percentile(gains, 10),
    medianGainPct: percentile(gains, 50),
    maxGainPct: gains[gains.length - 1],
    medianDaysToPeak: percentile(daysToPeak, 50),
    maxDaysToPeak: daysToPeak[daysToPeak.length - 1] ?? null,
  };
}

function formatRiskReport(ruleLabel, entries, summary) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Risikoprofil: ${ruleLabel}`);
  if (summary.n === 0) {
    lines.push('Keine echten Treffer dieser Regel im Backtest-Zeitraum — kein Risikoprofil berechenbar.');
    return lines.join('\n');
  }
  lines.push(`Basis: ${summary.n} echte Treffer (Regel feuert, danach folgt tatsächlich ein Squeeze).`);
  lines.push('');
  lines.push(`  Median-Rückgang nach Entry vor Squeeze-Beginn: ${summary.medianDrawdownPct.toFixed(1)}%`);
  lines.push(`  Schlechteste 10% der Fälle fielen mindestens:  ${summary.p90DrawdownPct.toFixed(1)}%`);
  lines.push(`  Schlechtester Einzelfall:                      ${summary.maxDrawdownPct.toFixed(1)}%`);
  lines.push(`  Median Handelstage bis zum Tiefpunkt:           ${summary.medianDaysToWorst}`);
  lines.push(`  Median Handelstage bis Squeeze-Beginn:          ${summary.medianDaysToSqueezeStart}`);
  lines.push(`  Längste beobachtete Wartezeit:                  ${summary.maxDaysToSqueezeStart} Handelstage`);
  lines.push('');
  lines.push(
    `Grobe Einordnung SL: ein Stop-Loss bei ${Math.abs(summary.p90DrawdownPct).toFixed(0)}% hätte ~90% dieser echten Treffer NICHT vorzeitig ausgestoppt. Ein engerer SL erhöht das Risiko, genau die Fälle zu verpassen, die man eigentlich erwischen wollte.`
  );
  lines.push('');
  lines.push(`  Median-Gewinn vom Entry bis zum Peak:           +${summary.medianGainPct.toFixed(1)}%`);
  lines.push(`  Schwächste 10% der Fälle erreichten höchstens:  +${summary.p10GainPct.toFixed(1)}%`);
  lines.push(`  Bester Einzelfall:                              +${summary.maxGainPct.toFixed(1)}%`);
  lines.push(`  Median Handelstage bis zum Peak:                ${summary.medianDaysToPeak}`);
  lines.push(`  Längste beobachtete Zeit bis zum Peak:          ${summary.maxDaysToPeak} Handelstage`);
  lines.push('');
  lines.push(
    `Grobe Einordnung TP: ein Take-Profit bei +${summary.p10GainPct.toFixed(0)}% hätte ~90% dieser echten Treffer erfasst, bevor der Kurs wieder drehte. Ein höheres TP-Ziel hätte in den schwächeren Fällen Gewinn liegen gelassen (Peak schon erreicht/überschritten). n=${summary.n} ist klein — als grobe Kalibrierung zu verstehen, nicht als feste Regel.`
  );
  return lines.join('\n');
}

module.exports = { analyzeRiskProfile, summarizeRiskProfile, formatRiskReport, findRuleByConditions };

const fs = require('fs');
const path = require('path');
const { getDb, logRun, upsertTicker } = require('../db/database');
const yahoo = require('../collectors/yahooFinance');
const { getPriceSeries } = require('../analysis/technicals');
const { detectSqueezeEvents } = require('../analysis/squeezeDetector');

const CANDIDATES_PATH = path.join(__dirname, 'candidates.json');

const STANDARD_OPTIONS = {}; // Default-Schwellenwerte aus squeezeDetector.js
const RELAXED_OPTIONS = { riseThreshold: 0.3, maxRiseDays: 60, dropThreshold: 0.12, maxDropWindow: 60 };

function readCandidates() {
  return JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
}

function targetWindow(years) {
  const min = Math.min(...years);
  const max = Math.max(...years);
  return { from: `${min - 1}-01-01`, to: `${max + 1}-12-31`, matchFrom: `${min}-01-01`, matchTo: `${max}-12-31` };
}

function bestMatchInWindow(candidates, matchFrom, matchTo) {
  const bufferDays = 90 * 24 * 60 * 60 * 1000;
  const from = new Date(new Date(matchFrom).getTime() - bufferDays).toISOString().slice(0, 10);
  const to = new Date(new Date(matchTo).getTime() + bufferDays).toISOString().slice(0, 10);
  const inRange = candidates.filter((c) => c.peakDate >= from && c.peakDate <= to);
  if (inRange.length === 0) return null;
  return inRange.sort((a, b) => b.gainPercent - a.gainPercent)[0];
}

function overlapsExisting(candidate, existingWindows) {
  return existingWindows.some(([s, e]) => candidate.startDate <= e && candidate.endDate >= s);
}

const insertVerified = (db) =>
  db.prepare(
    `INSERT INTO squeeze_events (
       symbol, event_name, detection_method, start_date, peak_date, end_date,
       trigger_type, price_before, price_peak, gain_percent, rise_duration_days,
       price_after, drop_percent, drop_duration_days, source, notes
     ) VALUES (
       @symbol, @eventName, 'verified', @startDate, @peakDate, @endDate,
       @triggerType, @priceBefore, @pricePeak, @gainPercent, @riseDurationDays,
       @priceAfter, @dropPercent, @dropDurationDays, @source, @notes
     )
     ON CONFLICT(symbol, event_name) DO NOTHING`
  );

/**
 * Verarbeitet die von Nutzer:in kuratierte Kandidatenliste
 * (research/knowledge/candidates.json): pro Zeile Ticker verifizieren,
 * Kurshistorie um das genannte Jahr backfillen und den Squeeze-Detektor
 * gezielt in diesem Fenster suchen lassen (statt blind wie beim
 * Universums-Scan). Ergebnis landet als detection_method='verified' —
 * Ticker/Jahr/Typ stammen von Nutzer:in, Kurskennzahlen sind automatisch
 * extrahiert, kein von Hand recherchierter Auslöser-Text.
 */
async function processCandidates() {
  const db = getDb();
  const candidates = readCandidates();
  const insert = insertVerified(db);
  const existingStmt = db.prepare(`SELECT start_date, end_date FROM squeeze_events WHERE symbol = ?`);

  const report = { inserted: [], alreadyCovered: [], noPatternFound: [], tickerInvalid: [], skipped: [] };

  for (const c of candidates) {
    if (c.skip) {
      report.skipped.push({ n: c.n, ticker: c.ticker, reason: c.skipReason });
      continue;
    }

    const symbol = c.yahooSymbol || c.ticker;
    const { from, to, matchFrom, matchTo } = targetWindow(c.years);
    const startedAt = new Date().toISOString();

    let bars;
    try {
      bars = await yahoo.fetchDailyBars(symbol, { from, to: to > new Date().toISOString().slice(0, 10) ? undefined : to });
    } catch (err) {
      logRun('knowledge:verify', symbol, 'error', err.message, startedAt);
      report.tickerInvalid.push({ n: c.n, ticker: c.ticker, symbol, company: c.company, reason: err.message });
      continue;
    }

    if (bars.length === 0) {
      logRun('knowledge:verify', symbol, 'error', 'Keine Kursdaten im Zeitfenster', startedAt);
      report.tickerInvalid.push({ n: c.n, ticker: c.ticker, symbol, company: c.company, reason: 'Keine Kursdaten im Zeitfenster' });
      continue;
    }

    upsertTicker(symbol, c.company);
    yahoo.storeBars(db, symbol, bars);
    logRun('knowledge:verify', symbol, 'ok', `${bars.length} Kursdatensätze`, startedAt);

    const series = getPriceSeries(db, symbol);
    let matches = detectSqueezeEvents(series, STANDARD_OPTIONS);
    let match = bestMatchInWindow(matches, matchFrom, matchTo);
    if (!match) {
      matches = detectSqueezeEvents(series, RELAXED_OPTIONS);
      match = bestMatchInWindow(matches, matchFrom, matchTo);
    }

    if (!match) {
      report.noPatternFound.push({ n: c.n, ticker: c.ticker, symbol, company: c.company, years: c.years });
      continue;
    }

    const existingWindows = existingStmt.all(symbol).map((r) => [r.start_date, r.end_date || r.start_date]);
    if (overlapsExisting(match, existingWindows)) {
      report.alreadyCovered.push({ n: c.n, ticker: c.ticker, symbol, company: c.company, peakDate: match.peakDate });
      continue;
    }

    const eventName = `${c.company} ${symbol} Squeeze ${c.years[0]}`;
    insert.run({
      symbol,
      eventName,
      startDate: match.startDate,
      peakDate: match.peakDate,
      endDate: match.endDate,
      triggerType: c.type,
      priceBefore: match.priceBefore,
      pricePeak: match.pricePeak,
      gainPercent: match.gainPercent,
      riseDurationDays: match.riseDurationDays,
      priceAfter: match.priceAfter,
      dropPercent: match.dropPercent,
      dropDurationDays: match.dropDurationDays,
      source: 'Ticker/Jahr/Typ von Nutzer:in benannt (PROJECT SQUEEZE DATABASE); Kurskennzahlen automatisch aus Kurshistorie extrahiert, kein manuell recherchierter Auslöser-Text.',
      notes: c.note || null,
    });

    existingWindows.push([match.startDate, match.endDate]);
    report.inserted.push({
      n: c.n,
      ticker: c.ticker,
      symbol,
      company: c.company,
      startDate: match.startDate,
      peakDate: match.peakDate,
      gainPercent: match.gainPercent,
      dropPercent: match.dropPercent,
    });
  }

  return report;
}

function formatReport(report) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Kandidatenliste verarbeitet`);
  lines.push(`  Neu eingefügt (verified):     ${report.inserted.length}`);
  lines.push(`  Bereits abgedeckt:            ${report.alreadyCovered.length}`);
  lines.push(`  Kein Muster im Fenster:       ${report.noPatternFound.length}`);
  lines.push(`  Ticker ungültig/delistet:     ${report.tickerInvalid.length}`);
  lines.push(`  Bewusst übersprungen:         ${report.skipped.length}`);
  lines.push('');
  if (report.inserted.length) {
    lines.push('Neu eingefügt:');
    for (const r of report.inserted) {
      lines.push(`  #${r.n} ${r.company} (${r.symbol})  ${r.startDate} → ${r.peakDate}  +${r.gainPercent.toFixed(0)}% / -${r.dropPercent.toFixed(0)}%`);
    }
    lines.push('');
  }
  if (report.noPatternFound.length) {
    lines.push('Kein Muster gefunden (manuell prüfen oder Schwellenwerte anpassen):');
    lines.push('  ' + report.noPatternFound.map((r) => `#${r.n} ${r.ticker}`).join(', '));
    lines.push('');
  }
  if (report.tickerInvalid.length) {
    lines.push('Ticker ungültig/keine Daten (vermutlich delistet):');
    lines.push('  ' + report.tickerInvalid.map((r) => `#${r.n} ${r.ticker}`).join(', '));
  }
  return lines.join('\n');
}

module.exports = { processCandidates, formatReport };

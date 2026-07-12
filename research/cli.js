require('dotenv').config();
const { runDailyCollection } = require('./collectors/runAll');
const { backfillEventWindows } = require('./collectors/backfillEvents');
const watchlist = require('./config/watchlist');
const { getDb } = require('./db/database');
const { loadEvents, listEvents } = require('./knowledge/loader');
const { runStatistics, formatReport } = require('./analysis/statistics');
const { generateRules, storeRules, formatRulesReport } = require('./analysis/ruleGenerator');
const { backfillUniverse } = require('./collectors/universeBackfill');
const { scanAllSymbols } = require('./analysis/squeezeDetector');
const universe = require('./config/universe');
const { processCandidates, formatReport: formatCandidatesReport } = require('./knowledge/verifyCandidates');
const { runBacktest, storeBacktestResults, formatBacktestReport } = require('./analysis/backtest');
const { backfillCatalystData } = require('./collectors/catalystBackfill');
const { summarizeCatalystCoverage, formatCatalystSummary } = require('./analysis/catalyst');
const { backfillControlWindows } = require('./collectors/catalystControlBackfill');
const { analyzeRiskProfile, analyzeKnowledgeBaseRiskProfile, summarizeRiskProfile, formatRiskReport } = require('./analysis/riskProfile');
const { scanSymbols, formatScanReport } = require('./analysis/squeezeScore');
const { computeDNAForSymbols, formatDNAReport } = require('./analysis/dnaEngine');
const { collectPreEventStates, formatPreEventReport } = require('./analysis/recallDiagnosis');
const { runIgnitionTest, formatIgnitionReport } = require('./analysis/ignition');
const { buildControlFeatureSet } = require('./analysis/statistics');

const command = process.argv[2] || 'run';

async function main() {
  if (command === 'run') {
    console.log(`[Squeeze Research] Sammle Daten für: ${watchlist.join(', ')}`);
    const results = await runDailyCollection(watchlist);
    for (const r of results) {
      const detail = r.status === 'ok' ? `${r.count} Datensätze` : r.message;
      console.log(`  ${r.status === 'ok' ? '✔' : '✘'} ${r.module.padEnd(14)} ${r.symbol.padEnd(6)} ${detail}`);
    }
    return;
  }

  if (command === 'backfill') {
    const symbol = process.argv[3];
    const range = process.argv[4] || '2y';
    if (!symbol) {
      console.error('Nutzung: node research/cli.js backfill <SYMBOL> [range]');
      process.exit(1);
    }
    console.log(`[Squeeze Research] Backfill ${symbol} (${range})`);
    const results = await runDailyCollection([symbol], { priceRange: range });
    for (const r of results) {
      const detail = r.status === 'ok' ? `${r.count} Datensätze` : r.message;
      console.log(`  ${r.status === 'ok' ? '✔' : '✘'} ${r.module.padEnd(14)} ${r.symbol.padEnd(6)} ${detail}`);
    }
    return;
  }

  if (command === 'knowledge:load') {
    const db = getDb();
    const n = loadEvents(db);
    console.log(`[Squeeze Research] ${n} Squeeze-Fälle aus research/knowledge/events.json geladen`);
    return;
  }

  if (command === 'knowledge:list') {
    const db = getDb();
    const rows = listEvents(db);
    if (rows.length === 0) {
      console.log('Keine Einträge — zuerst "node research/cli.js knowledge:load" ausführen.');
      return;
    }
    for (const r of rows) {
      const gain = r.gain_percent != null ? `+${r.gain_percent.toFixed(0)}%` : '?';
      const drop = r.drop_percent != null ? `${r.drop_percent.toFixed(0)}%` : '?';
      console.log(
        `  ${r.symbol.padEnd(6)} ${r.start_date} → ${r.peak_date}  Anstieg ${gain}  Fall ${drop}  (${r.trigger_type})  — ${r.event_name}`
      );
    }
    return;
  }

  if (command === 'backfill:events') {
    console.log('[Squeeze Research] Backfill Kurshistorie rund um alle erfassten Squeeze-Events...');
    const results = await backfillEventWindows();
    for (const r of results) {
      const label = r.module === 'finra' ? 'finra' : 'yahooFinance';
      const detail = r.status === 'ok' ? `${r.count} Datensätze` : r.message;
      console.log(`  ${r.status === 'ok' ? '✔' : '✘'} ${label.padEnd(14)} ${r.symbol.padEnd(6)} ${detail}`);
    }
    return;
  }

  if (command === 'stats:run') {
    const db = getDb();
    const report = runStatistics(db);
    console.log(formatReport(report));
    return;
  }

  if (command === 'rules:generate') {
    const db = getDb();
    const rules = generateRules(db);
    storeRules(db, rules);
    console.log(formatRulesReport(rules));
    return;
  }

  if (command === 'universe:backfill') {
    const range = process.argv[3] || '5y';
    const symbols = [...new Set([...watchlist, ...universe])];
    console.log(`[Squeeze Research] Backfill Langzeit-Historie (${range}) für ${symbols.length} Symbole...`);
    const results = await backfillUniverse(symbols, { range });
    const failed = results.filter((r) => r.status === 'error');
    const ok = results.filter((r) => r.status === 'ok');
    console.log(`Fertig: ${ok.length} OK, ${failed.length} Fehler (meist delistete Symbole — erwartbar).`);
    if (failed.length) {
      console.log('Fehlgeschlagen:', failed.map((r) => `${r.symbol}(${r.module})`).join(', '));
    }
    return;
  }

  if (command === 'knowledge:scan') {
    const db = getDb();
    console.log('[Squeeze Research] Scanne alle Symbole mit Kurshistorie nach Squeeze-Mustern...');
    const result = scanAllSymbols(db);
    console.log(`Gescannt: ${result.scanned} Symbole. Neu erkannt: ${result.inserted} Fälle.`);
    for (const [symbol, count] of Object.entries(result.bySymbol)) {
      console.log(`  ${symbol.padEnd(8)} ${count} neue(r) Fall/Fälle`);
    }
    return;
  }

  if (command === 'knowledge:verify') {
    console.log('[Squeeze Research] Verarbeite research/knowledge/candidates.json...');
    const report = await processCandidates();
    console.log(formatCandidatesReport(report));
    return;
  }

  if (command === 'backtest:run') {
    const lookaheadDays = Number(process.argv[3]) || 10;
    const db = getDb();
    console.log(`[Squeeze Research] Backtest über alle Handelstage (Lookahead ${lookaheadDays} Tage)...`);
    const results = runBacktest(db, { lookaheadDays });
    storeBacktestResults(db, results, lookaheadDays);
    console.log(formatBacktestReport(results, { lookaheadDays }));
    return;
  }

  if (command === 'catalyst:backfill') {
    console.log('[Squeeze Research] Backfill News-Sentiment für offene Squeeze-Fälle (Modul 4)...');
    const { results, stillPending } = await backfillCatalystData();
    for (const r of results) {
      const detail = r.status === 'ok' ? `${r.count} Tage mit News` : r.message || r.reason;
      console.log(`  ${r.status === 'ok' ? '✔' : '✘'} ${r.symbol.padEnd(8)} ${detail}`);
    }
    console.log(`Diesen Lauf verarbeitet: ${results.length}. Noch offen (nächster Lauf): ${stillPending}.`);
    return;
  }

  if (command === 'catalyst:summary') {
    const db = getDb();
    console.log(formatCatalystSummary(summarizeCatalystCoverage(db)));
    return;
  }

  if (command === 'catalyst:control-backfill') {
    console.log('[Squeeze Research] Backfill News-Sentiment für Kontrollgruppen-Fenster (Modul 4)...');
    const { results, totalCovered, target } = await backfillControlWindows();
    for (const r of results) {
      const detail = r.status === 'ok' ? `${r.count} Tage mit News` : r.message || r.reason;
      console.log(`  ${r.status === 'ok' ? '✔' : '✘'} ${r.symbol.padEnd(8)} ${detail}`);
    }
    console.log(`Diesen Lauf verarbeitet: ${results.length}. Kontrollfenster insgesamt: ${totalCovered}/${target}.`);
    return;
  }

  if (command === 'risk:analyze') {
    const lookaheadDays = Number(process.argv[3]) || 10;
    const minSignals = Number(process.argv[4]) || 15;
    const db = getDb();

    const candidates = db
      .prepare(
        `SELECT label, conditions, true_positives + false_positives AS signals, precision_pct
         FROM backtest_results
         WHERE lookahead_days = ? AND (true_positives + false_positives) >= ?
         ORDER BY precision_pct DESC
         LIMIT 3`
      )
      .all(lookaheadDays, minSignals);

    if (candidates.length === 0) {
      console.log(
        `Keine Regel mit >=${minSignals} Signalen bei Lookahead=${lookaheadDays} gefunden. Erst "backtest:run ${lookaheadDays}" laufen lassen, oder minSignals senken: risk:analyze ${lookaheadDays} <minSignals>`
      );
      return;
    }

    for (const c of candidates) {
      const conditions = JSON.parse(c.conditions);
      const entries = analyzeRiskProfile(db, conditions, { lookaheadDays });
      const summary = summarizeRiskProfile(entries);
      console.log(formatRiskReport(c.label, entries, summary));
      console.log('');
    }
    return;
  }

  if (command === 'scan') {
    const lookaheadDays = Number(process.argv[3]) || 10;
    const minSignals = Number(process.argv[4]) || 15;
    const minLiftFactor = Number(process.argv[5]) || 1.5;
    const db = getDb();
    const symbols = [...new Set([...watchlist, ...universe])];
    const scan = scanSymbols(db, symbols, { lookaheadDays, minSignals, minLiftFactor });
    console.log(formatScanReport(scan));
    return;
  }

  if (command === 'risk:knowledge-base') {
    const entryLeadDays = Number(process.argv[3]) || 10;
    const db = getDb();
    const entries = analyzeKnowledgeBaseRiskProfile(db, { entryLeadDays });
    const summary = summarizeRiskProfile(entries);
    console.log(
      formatRiskReport(
        `Alle kuratierten Squeeze-Fälle (Entry ${entryLeadDays} Handelstage vor Squeeze-Start)`,
        entries,
        summary,
        `kuratierte Fälle mit auswertbaren Kursdaten (von ${
          db.prepare(`SELECT COUNT(*) AS n FROM squeeze_events WHERE detection_method IN ('manual','verified')`).get().n
        } insgesamt — Rest ohne Kursdaten, z.B. delistete/pseudo-Symbole wie SPRT, VOW3-2008, BBBY-2022)`
      )
    );
    return;
  }

  if (command === 'dna') {
    const db = getDb();
    const symbols = [...new Set([...watchlist, ...universe])];
    const profiles = computeDNAForSymbols(db, symbols);
    console.log(formatDNAReport(profiles));
    return;
  }

  if (command === 'stats:pre-event') {
    const db = getDb();
    const states = collectPreEventStates(db);
    const events = db.prepare(`SELECT symbol, event_name, start_date, end_date, metrics_at_trigger FROM squeeze_events`).all();
    const controlRows = buildControlFeatureSet(db, events);
    console.log(formatPreEventReport(states, controlRows));
    return;
  }

  if (command === 'ignition:test') {
    const lookaheadDays = Number(process.argv[3]) || 10;
    const db = getDb();
    const result = runIgnitionTest(db, { lookaheadDays });
    console.log(formatIgnitionReport(result, { lookaheadDays }));
    return;
  }

  console.error(
    `Unbekanntes Kommando: ${command}\nVerfügbar: run | backfill <SYMBOL> [range] | backfill:events | knowledge:load | knowledge:list | stats:run | stats:pre-event | rules:generate | universe:backfill [range] | knowledge:scan | knowledge:verify | backtest:run [lookaheadDays] | catalyst:backfill | catalyst:summary | catalyst:control-backfill | risk:analyze [lookaheadDays] [minSignals] | risk:knowledge-base [entryLeadDays] | scan [lookaheadDays] [minSignals] | dna | ignition:test [lookaheadDays]`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[Squeeze Research] Fehlgeschlagen:', err);
  process.exit(1);
});

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

  console.error(
    `Unbekanntes Kommando: ${command}\nVerfügbar: run | backfill <SYMBOL> [range] | backfill:events | knowledge:load | knowledge:list | stats:run | rules:generate | universe:backfill [range] | knowledge:scan`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[Squeeze Research] Fehlgeschlagen:', err);
  process.exit(1);
});

require('dotenv').config();
const { runDailyCollection } = require('./collectors/runAll');
const watchlist = require('./config/watchlist');
const { getDb } = require('./db/database');
const { loadEvents, listEvents } = require('./knowledge/loader');

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

  console.error(
    `Unbekanntes Kommando: ${command}\nVerfügbar: run | backfill <SYMBOL> [range] | knowledge:load | knowledge:list`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[Squeeze Research] Fehlgeschlagen:', err);
  process.exit(1);
});

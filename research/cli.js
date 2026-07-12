require('dotenv').config();
const { runDailyCollection } = require('./collectors/runAll');
const watchlist = require('./config/watchlist');

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

  console.error(`Unbekanntes Kommando: ${command}\nVerfügbar: run | backfill <SYMBOL> [range]`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[Squeeze Research] Fehlgeschlagen:', err);
  process.exit(1);
});

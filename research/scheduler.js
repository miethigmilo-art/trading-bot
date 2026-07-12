require('dotenv').config();
const cron = require('node-cron');
const { runDailyCollection } = require('./collectors/runAll');
const watchlist = require('./config/watchlist');

// Werktags 21:30 UTC (~16:30–17:30 ET, nach US-Handelsschluss inkl. Puffer für Kursdaten).
const SCHEDULE = process.env.SQUEEZE_CRON_SCHEDULE || '30 21 * * 1-5';

console.log(`[Squeeze Research] Scheduler aktiv — Cron: "${SCHEDULE}"`);

cron.schedule(SCHEDULE, async () => {
  console.log(`[Squeeze Research] Starte täglichen Sammellauf (${new Date().toISOString()})`);
  try {
    const results = await runDailyCollection(watchlist);
    const failed = results.filter((r) => r.status === 'error');
    console.log(`[Squeeze Research] Fertig: ${results.length} Schritte, ${failed.length} Fehler`);
  } catch (err) {
    console.error('[Squeeze Research] Sammellauf fehlgeschlagen:', err);
  }
});

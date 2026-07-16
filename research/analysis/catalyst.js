/**
 * Modul 4 (Catalyst Engine) — Auswertung des bisher gesammelten
 * News-Sentiments. Bewusst (noch) NICHT als Predicate in ruleGenerator.js/
 * backtest.js verdrahtet: die Kontrollgruppe (normale Handelstage) hat so
 * gut wie keine News-Sentiment-Abdeckung, weil wir aus Quota-Gründen gezielt
 * nur die Fenster um kuratierte Squeeze-Fälle abfragen (siehe
 * catalystBackfill.js). Ein Lift-/Precision-Vergleich wäre mit dieser
 * einseitigen Abdeckung irreführend. Diese Funktion liefert stattdessen
 * einen ehrlichen Zwischenstand: was wissen wir bisher, für wie viele Fälle.
 */
function summarizeCatalystCoverage(db) {
  const rows = db
    .prepare(
      `SELECT se.symbol, se.event_name, se.start_date,
         (SELECT SUM(article_count) FROM news_sentiment ns
          WHERE ns.symbol = se.symbol AND ns.date BETWEEN date(se.start_date, '-14 days') AND se.start_date) AS articles_before,
         (SELECT AVG(avg_sentiment) FROM news_sentiment ns
          WHERE ns.symbol = se.symbol AND ns.date BETWEEN date(se.start_date, '-14 days') AND se.start_date) AS sentiment_before
       FROM squeeze_events se
       WHERE detection_method IN ('manual', 'verified')
       ORDER BY start_date DESC`
    )
    .all();

  const covered = rows.filter((r) => r.articles_before != null);
  return { total: rows.length, covered: covered.length, rows: covered };
}

function formatCatalystSummary({ total, covered, rows }) {
  const lines = [];
  lines.push(`PROJECT SQUEEZE — Modul 4: Catalyst Engine (${covered}/${total} kuratierte Fälle mit News-Daten)`);
  lines.push(
    `Hinweis: Noch nicht in Statistik/Regelgenerator/Backtest integriert — dafür fehlt eine Kontrollgruppe mit vergleichbarer Abdeckung (25 Alpha-Vantage-Calls/Tag reichen nur für die kuratierten Fälle selbst, siehe catalyst:backfill). Rein qualitativer Zwischenstand.`
  );
  lines.push('');
  for (const r of rows.slice(0, 25)) {
    const articles = r.articles_before ?? 0;
    const sentiment = r.sentiment_before != null ? r.sentiment_before.toFixed(2) : 'n/a';
    const label = r.sentiment_before >= 0.15 ? 'bullish' : r.sentiment_before <= -0.15 ? 'bearish' : 'neutral';
    lines.push(`  ${r.symbol.padEnd(6)} ${r.start_date}  ${String(articles).padStart(2)} Artikel (14 Tage vorher)  Sentiment: ${sentiment} (${label})  — ${r.event_name}`);
  }
  return lines.join('\n');
}

module.exports = { summarizeCatalystCoverage, formatCatalystSummary };

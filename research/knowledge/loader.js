const fs = require('fs');
const path = require('path');

const EVENTS_PATH = path.join(__dirname, 'events.json');

function readEvents() {
  return JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
}

const pct = (from, to) => (from != null && to != null && from !== 0 ? ((to - from) / from) * 100 : null);

/**
 * Lädt research/knowledge/events.json in die squeeze_events-Tabelle.
 * gain_percent/drop_percent werden aus den Kursangaben berechnet statt im JSON
 * gepflegt, um Rechenfehler beim manuellen Editieren zu vermeiden.
 */
function loadEvents(db) {
  const events = readEvents();
  const insert = db.prepare(
    `INSERT INTO squeeze_events (
       symbol, event_name, start_date, peak_date, end_date,
       trigger_type, trigger_description, chart_pattern, metrics_at_trigger,
       price_before, price_peak, gain_percent, rise_duration_days,
       price_after, drop_percent, drop_duration_days,
       rule_would_detect, rule_false_positive_risk, source, notes
     ) VALUES (
       @symbol, @eventName, @startDate, @peakDate, @endDate,
       @triggerType, @triggerDescription, @chartPattern, @metricsAtTrigger,
       @priceBefore, @pricePeak, @gainPercent, @riseDurationDays,
       @priceAfter, @dropPercent, @dropDurationDays,
       @ruleWouldDetect, @ruleFalsePositiveRisk, @source, @notes
     )
     ON CONFLICT(symbol, event_name) DO UPDATE SET
       start_date = excluded.start_date, peak_date = excluded.peak_date, end_date = excluded.end_date,
       trigger_type = excluded.trigger_type, trigger_description = excluded.trigger_description,
       chart_pattern = excluded.chart_pattern, metrics_at_trigger = excluded.metrics_at_trigger,
       price_before = excluded.price_before, price_peak = excluded.price_peak,
       gain_percent = excluded.gain_percent, rise_duration_days = excluded.rise_duration_days,
       price_after = excluded.price_after, drop_percent = excluded.drop_percent,
       drop_duration_days = excluded.drop_duration_days,
       rule_would_detect = excluded.rule_would_detect,
       rule_false_positive_risk = excluded.rule_false_positive_risk,
       source = excluded.source, notes = excluded.notes`
  );

  const insertMany = db.transaction((rows) => {
    for (const e of rows) {
      insert.run({
        symbol: e.symbol,
        eventName: e.eventName,
        startDate: e.startDate,
        peakDate: e.peakDate ?? null,
        endDate: e.endDate ?? null,
        triggerType: e.triggerType ?? null,
        triggerDescription: e.triggerDescription ?? null,
        chartPattern: e.chartPattern ?? null,
        metricsAtTrigger: e.metricsAtTrigger ? JSON.stringify(e.metricsAtTrigger) : null,
        priceBefore: e.priceBefore ?? null,
        pricePeak: e.pricePeak ?? null,
        gainPercent: pct(e.priceBefore, e.pricePeak),
        riseDurationDays: e.riseDurationDays ?? null,
        priceAfter: e.priceAfter ?? null,
        dropPercent: pct(e.pricePeak, e.priceAfter),
        dropDurationDays: e.dropDurationDays ?? null,
        ruleWouldDetect: e.ruleWouldDetect ?? null,
        ruleFalsePositiveRisk: e.ruleFalsePositiveRisk ?? null,
        source: e.source ?? null,
        notes: e.notes ?? null,
      });
    }
  });
  insertMany(events);
  return events.length;
}

function listEvents(db) {
  return db
    .prepare(
      `SELECT symbol, event_name, start_date, peak_date, gain_percent, drop_percent, trigger_type
       FROM squeeze_events ORDER BY start_date`
    )
    .all();
}

module.exports = { loadEvents, listEvents };

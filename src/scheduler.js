/**
 * Time-based automations (runs every few minutes):
 *  - reminder to all crew/suppliers REMINDER_HOURS_BEFORE hours (default 24) before soundcheck
 *  - manager alert for anyone still unconfirmed UNCONFIRMED_ALERT_HOURS (default 48) before the event
 */
const cron = require('node-cron');
const config = require('./config');
const { db } = require('./db');
const { eventStart, todayIso } = require('./util');
const production = require('./services/production');

let running = false;

async function runOnce(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const out = { reminders: [], alerts: [] };
  try {
    const events = db.prepare(`SELECT * FROM events
      WHERE status IN ('planning','approved') AND date >= date(?, '-1 day')`).all(todayIso());

    for (const ev of events) {
      const start = eventStart(ev);
      if (!start) continue;
      const hoursLeft = (start - now) / 3600e3;
      if (hoursLeft <= 0) continue;

      if (!ev.reminder_sent_at && hoursLeft <= config.reminderHoursBefore) {
        const assigned = db.prepare("SELECT COUNT(*) AS c FROM assignments WHERE event_id = ? AND confirm_status != 'declined'").get(ev.id).c;
        if (assigned > 0) {
          const r = await production.sendEventReminder(ev.id);
          out.reminders.push({ event: ev.id, ...r });
        }
      }

      if (hoursLeft <= config.unconfirmedAlertHours) {
        const r = await production.sendUnconfirmedAlert(ev.id);
        if (r.sent !== false || r.count) out.alerts.push({ event: ev.id, ...r });
      }
    }
  } catch (err) {
    console.error('[scheduler] error:', err);
  } finally {
    running = false;
  }
  if (out.reminders.length || out.alerts.length) console.log('[scheduler]', JSON.stringify(out));
  return out;
}

function start() {
  cron.schedule(config.schedulerCron, () => { runOnce(); });
  setTimeout(() => runOnce(), 5000);
  console.log(`[scheduler] running on "${config.schedulerCron}"`);
}

module.exports = { start, runOnce };

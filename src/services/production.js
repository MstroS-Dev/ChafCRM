/**
 * System 1 — events, crew assignments, confirmations and crew-facing messages.
 */
const config = require('../config');
const { db } = require('../db');
const labels = require('../labels');
const { sendWhatsApp, sendToManager } = require('../messaging');
const { fmtDateLong, wazeLink, sqlNow, eventStart } = require('../util');

function getEvent(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

function timelineFor(eventId, audienceKind) {
  const rows = db.prepare('SELECT * FROM timeline_items WHERE event_id = ? ORDER BY sort, time, id').all(eventId);
  if (!audienceKind) return rows;
  // musicians & tech see "all" + "musicians"; suppliers see "all" + "suppliers"
  const want = audienceKind === 'supplier' ? 'suppliers' : 'musicians';
  return rows.filter((r) => r.audience === 'all' || r.audience === want);
}

function crewLink(crew) {
  return `${config.baseUrl}/c/${crew.token}`;
}

function assignmentLink(crew, assignmentId) {
  return `${config.baseUrl}/c/${crew.token}/a/${assignmentId}`;
}

/**
 * What a crew member or supplier may see about an event.
 * Never includes price, client contact details or internal notes.
 */
function crewView(ev, crewKind) {
  return {
    id: ev.id,
    name: ev.name,
    event_type: ev.event_type,
    date: ev.date,
    venue: ev.venue,
    address: ev.address,
    arrival_time: ev.arrival_time,
    soundcheck_time: ev.soundcheck_time,
    reception_time: ev.reception_time,
    status: ev.status,
    crew_notes: ev.crew_notes,
    tech_requirements: crewKind === 'supplier' || crewKind === 'tech' ? ev.tech_requirements : null,
    waze: wazeLink(ev),
    timeline: timelineFor(ev.id, crewKind),
  };
}

function eventSummaryLines(view) {
  const lines = [
    `📅 ${fmtDateLong(view.date)}`,
    view.venue || view.address ? `📍 ${[view.venue, view.address].filter(Boolean).join(', ')}` : null,
    view.arrival_time ? `🕐 הגעה: ${view.arrival_time}` : null,
    view.soundcheck_time ? `🎚️ סאונד-צ׳ק: ${view.soundcheck_time}` : null,
  ];
  return lines.filter(Boolean);
}

function timelineLines(view) {
  if (!view.timeline.length) return [];
  return ['', '🗒️ לו״ז:', ...view.timeline.map((t) => `• ${t.time ? t.time + ' – ' : ''}${t.label}`)];
}

/** Initial booking message with confirm / decline link. */
async function sendBookingMessage(assignmentId) {
  const a = db.prepare(`
    SELECT a.*, c.name AS crew_name, c.phone, c.kind, c.token
    FROM assignments a JOIN crew c ON c.id = a.crew_id WHERE a.id = ?`).get(assignmentId);
  if (!a) return { ok: false, error: 'assignment not found' };
  const ev = getEvent(a.event_id);
  const view = crewView(ev, a.kind);
  const link = assignmentLink({ token: a.token }, a.id);
  const text = [
    `היי ${a.crew_name} 👋`,
    `שובצת לאירוע: *${ev.name}*${a.position ? ` (${a.position})` : ''}`,
    '',
    ...eventSummaryLines(view),
    '',
    'לאישור הגעה:',
    `✅ מאשר / ❌ לא מאשר — ${link}`,
    '',
    'אפשר גם לענות כאן "מאשר" או "לא מאשר".',
  ].join('\n');
  const res = await sendWhatsApp(a.phone, text, `assignment:${a.id}`);
  if (res.ok) db.prepare('UPDATE assignments SET notified_at = ? WHERE id = ?').run(sqlNow(), a.id);
  return res;
}

/** Crew member answers (from the link page or a WhatsApp text reply). */
async function respond(assignmentId, answer) {
  const status = answer === 'confirmed' ? 'confirmed' : 'declined';
  const a = db.prepare(`
    SELECT a.*, c.name AS crew_name, e.name AS event_name, e.date
    FROM assignments a JOIN crew c ON c.id = a.crew_id JOIN events e ON e.id = a.event_id
    WHERE a.id = ?`).get(assignmentId);
  if (!a) return null;
  const changed = a.confirm_status !== status;
  db.prepare('UPDATE assignments SET confirm_status = ?, responded_at = ? WHERE id = ?')
    .run(status, sqlNow(), assignmentId);
  if (changed && status === 'declined') {
    await sendToManager(
      `⚠️ ${a.crew_name} סימן/ה "לא זמין" לאירוע ${a.event_name} (${fmtDateLong(a.date)}).\n` +
      `${config.baseUrl}/admin/events/${a.event_id}`,
      { ref: `declined:${a.id}` },
    );
  }
  return { ...a, confirm_status: status };
}

/** Reminder before the event — one consolidated message per crew member. */
async function sendEventReminder(eventId) {
  const ev = getEvent(eventId);
  if (!ev) return { sent: 0 };
  const rows = db.prepare(`
    SELECT a.*, c.name AS crew_name, c.phone, c.kind, c.token
    FROM assignments a JOIN crew c ON c.id = a.crew_id
    WHERE a.event_id = ? AND a.confirm_status != 'declined'`).all(eventId);
  let sent = 0;
  for (const a of rows) {
    const view = crewView(ev, a.kind);
    const parts = [
      `⏰ תזכורת: מחר ${ev.name}`,
      '',
      ...eventSummaryLines(view),
      view.waze ? `🚗 ניווט: ${view.waze}` : null,
      ...timelineLines(view),
      view.tech_requirements ? `\n🔧 דרישות טכניות:\n${view.tech_requirements}` : null,
      ev.crew_notes ? `\n📌 דגשים:\n${ev.crew_notes}` : null,
      '',
      `כל הפרטים: ${assignmentLink({ token: a.token }, a.id)}`,
    ].filter((x) => x !== null);
    const r = await sendWhatsApp(a.phone, parts.join('\n'), `reminder:${a.id}`);
    if (r.ok) sent += 1;
  }
  db.prepare('UPDATE events SET reminder_sent_at = ? WHERE id = ?').run(sqlNow(), eventId);
  return { sent, total: rows.length };
}

/** Alert manager about assignments still pending close to the event. */
async function sendUnconfirmedAlert(eventId) {
  const ev = getEvent(eventId);
  const pending = db.prepare(`
    SELECT a.id, c.name, c.phone, a.position FROM assignments a JOIN crew c ON c.id = a.crew_id
    WHERE a.event_id = ? AND a.confirm_status = 'pending' AND a.alerted_at IS NULL`).all(eventId);
  if (!pending.length) return { sent: false };
  const start = eventStart(ev);
  const hours = start ? Math.max(0, Math.round((start - Date.now()) / 3600e3)) : null;
  const text = [
    `🚨 חסרים אישורי הגעה — ${ev.name}`,
    `${fmtDateLong(ev.date)}${hours !== null ? ` (בעוד כ-${hours} שעות)` : ''}`,
    '',
    ...pending.map((p) => `• ${p.name}${p.position ? ` (${p.position})` : ''} — ${p.phone || 'אין טלפון'}`),
    '',
    `לטיפול: ${config.baseUrl}/admin/events/${ev.id}`,
  ].join('\n');
  const r = await sendToManager(text, { ref: `unconfirmed:${ev.id}` });
  const stamp = sqlNow();
  const upd = db.prepare('UPDATE assignments SET alerted_at = ? WHERE id = ?');
  pending.forEach((p) => upd.run(stamp, p.id));
  return { sent: r.ok, count: pending.length };
}

function addDefaultTimeline(eventId, ev) {
  const times = [ev.arrival_time, ev.soundcheck_time, ev.reception_time, null, null, null];
  const ins = db.prepare('INSERT INTO timeline_items (event_id, time, label, audience, sort) VALUES (?,?,?,?,?)');
  labels.defaultTimeline.forEach((t, i) => ins.run(eventId, times[i] || null, t.label, t.audience, (i + 1) * 10));
}

module.exports = {
  getEvent, timelineFor, crewView, crewLink, assignmentLink, sendBookingMessage, respond,
  sendEventReminder, sendUnconfirmedAlert, addDefaultTimeline,
};

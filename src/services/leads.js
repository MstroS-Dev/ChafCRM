/**
 * System 2 — lead intake, manager approval and client cards.
 */
const config = require('../config');
const { db, touch } = require('../db');
const labels = require('../labels');
const { signAction } = require('../auth');
const { sendWhatsApp, sendToManager, normalizePhone } = require('../messaging');
const { fmtDate, parseDate, str, sqlNow } = require('../util');
const production = require('./production');

function decisionLink(leadId) {
  return `${config.baseUrl}/l/${leadId}/${signAction('lead', leadId)}`;
}

async function notifyManager(leadId) {
  const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!l) return;
  const text = [
    '📩 ליד חדש נכנס!',
    '',
    `שם: ${l.name || '—'}`,
    `תאריך מבוקש: ${fmtDate(l.requested_date) || l.requested_date || '—'}`,
    `סוג אירוע: ${l.event_type || '—'}`,
    `טלפון: ${l.phone || '—'}`,
    l.location ? `מיקום: ${l.location}` : null,
    l.notes ? `הערות: ${l.notes}` : null,
    `מקור: ${labels.leadSource[l.source] || l.source}`,
    '',
    'האם ליצור כרטיס לקוח?',
    `👉 צור כרטיס לקוח / סמן כלא רלוונטי: ${decisionLink(l.id)}`,
  ].filter((x) => x !== null).join('\n');

  await sendToManager(text, {
    ref: `lead:${l.id}`,
    telegramButtons: [[
      { text: '✅ צור כרטיס לקוח', callback_data: `lead:approve:${l.id}` },
      { text: '🚫 סמן כלא רלוונטי', callback_data: `lead:reject:${l.id}` },
    ]],
  });
  db.prepare('UPDATE leads SET manager_notified_at = ? WHERE id = ?').run(sqlNow(), l.id);
}

/** Create a lead from any channel and alert the manager. */
async function createLead(input, { notify = true } = {}) {
  const lead = {
    name: str(input.name),
    phone: str(input.phone),
    email: str(input.email),
    requested_date: parseDate(str(input.requested_date || input.date)),
    event_type: str(input.event_type || input.type),
    location: str(input.location),
    notes: str(input.notes || input.message),
    source: labels.leadSource[input.source] ? input.source : 'webhook',
  };
  if (!lead.name && !lead.phone) throw new Error('נדרש שם או טלפון');
  const info = db.prepare(`INSERT INTO leads (name, phone, email, requested_date, event_type, location, notes, source)
    VALUES (@name, @phone, @email, @requested_date, @event_type, @location, @notes, @source)`).run(lead);
  const id = info.lastInsertRowid;
  if (notify) await notifyManager(id);
  return id;
}

/** Manager pressed "צור כרטיס לקוח". Idempotent. */
async function approveLead(leadId) {
  const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!l) return null;
  if (l.status === 'approved' && l.client_id) return { lead: l, clientId: l.client_id, already: true };

  const clientId = db.transaction(() => {
    const c = db.prepare(`INSERT INTO clients (lead_id, name, phone, email, requested_date, event_type, location, notes)
      VALUES (?,?,?,?,?,?,?,?)`).run(l.id, l.name || l.phone, l.phone, l.email, l.requested_date, l.event_type, l.location, l.notes);
    db.prepare("UPDATE leads SET status = 'approved', client_id = ?, decided_at = ? WHERE id = ?")
      .run(c.lastInsertRowid, sqlNow(), l.id);
    db.prepare("INSERT INTO interactions (client_id, kind, summary) VALUES (?, 'system', ?)")
      .run(c.lastInsertRowid, `פנייה התקבלה (${labels.leadSource[l.source] || l.source}) ב-${fmtDate(l.created_at.slice(0, 10))}`);
    return c.lastInsertRowid;
  })();

  if (config.autoReplyToClient && l.phone) {
    const first = (l.name || '').split(' ')[0];
    const text = `היי ${first || ''}, קיבלנו את פנייתך ונחזור אליך בהקדם! 🎶\n${config.brand}`.replace('היי ,', 'היי,');
    const r = await sendWhatsApp(l.phone, text, `client-ack:${clientId}`);
    if (r.ok) {
      db.prepare("INSERT INTO interactions (client_id, kind, summary) VALUES (?, 'whatsapp', ?)")
        .run(clientId, 'נשלחה הודעת אישור קבלה אוטומטית');
    }
  }
  return { lead: l, clientId, already: false };
}

function rejectLead(leadId) {
  const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!l) return null;
  if (l.status === 'new') {
    db.prepare("UPDATE leads SET status = 'rejected', decided_at = ? WHERE id = ?").run(sqlNow(), leadId);
  }
  return l;
}

/** Turn a closed client into an event in the production system. */
function convertClientToEvent(clientId) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!c) return null;
  if (c.event_id && production.getEvent(c.event_id)) return c.event_id;
  const lastQuote = db.prepare("SELECT amount FROM interactions WHERE client_id = ? AND kind = 'quote' AND amount IS NOT NULL ORDER BY id DESC LIMIT 1").get(clientId);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.requested_date || '') ? c.requested_date : new Date().toISOString().slice(0, 10);
  const eventId = db.transaction(() => {
    const ev = {
      name: `${c.event_type || 'אירוע'} – ${c.name}`,
      client_name: c.name,
      client_id: c.id,
      event_type: c.event_type,
      date,
      venue: c.location,
      price: lastQuote ? lastQuote.amount : null,
    };
    const info = db.prepare(`INSERT INTO events (name, client_name, client_id, event_type, date, venue, price, status)
      VALUES (@name, @client_name, @client_id, @event_type, @date, @venue, @price, 'approved')`).run(ev);
    production.addDefaultTimeline(info.lastInsertRowid, {});
    db.prepare("UPDATE clients SET status = 'closed', event_id = ? WHERE id = ?").run(info.lastInsertRowid, c.id);
    db.prepare("INSERT INTO interactions (client_id, kind, summary) VALUES (?, 'system', ?)")
      .run(c.id, `העסקה נסגרה ונפתח אירוע #${info.lastInsertRowid}`);
    return info.lastInsertRowid;
  })();
  touch('clients', c.id);
  return eventId;
}

/** Find a recent lead/client with this phone, to avoid duplicates from repeat WhatsApp messages. */
function findRecentByPhone(phone, days = 30) {
  const n = normalizePhone(phone);
  if (!n) return null;
  const tail = n.slice(-9);
  const rows = db.prepare(`SELECT id, phone, 'lead' AS t FROM leads WHERE created_at > datetime('now', ?)
    UNION ALL SELECT id, phone, 'client' AS t FROM clients WHERE created_at > datetime('now', ?)`)
    .all(`-${days} days`, `-${days} days`);
  return rows.find((r) => normalizePhone(r.phone).slice(-9) === tail) || null;
}

module.exports = { createLead, notifyManager, approveLead, rejectLead, convertClientToEvent, decisionLink, findRecentByPhone };

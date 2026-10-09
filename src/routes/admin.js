const express = require('express');
const bcrypt = require('bcryptjs');
const { db, newToken, touch } = require('../db');
const labels = require('../labels');
const { requireManager } = require('../auth');
const { intOrNull, str, timeOrNull, parseDate, todayIso } = require('../util');
const production = require('../services/production');
const leads = require('../services/leads');
const scheduler = require('../scheduler');

const r = express.Router();
r.use(requireManager);
r.use((req, res, next) => {
  res.locals.pendingLeads = db.prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'new'").get().c;
  next();
});

const back = (res, url, msg) => res.redirect(url + (msg ? (url.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg) : ''));
const pick = (obj, allowed, fallback) => (Object.prototype.hasOwnProperty.call(allowed, obj) ? obj : fallback);

// ───────────────────────── Dashboard
r.get('/', (req, res) => {
  const today = todayIso();
  const upcoming = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM assignments a WHERE a.event_id = e.id) AS crew_total,
      (SELECT COUNT(*) FROM assignments a WHERE a.event_id = e.id AND a.confirm_status = 'confirmed') AS crew_ok,
      (SELECT COUNT(*) FROM assignments a WHERE a.event_id = e.id AND a.confirm_status = 'pending') AS crew_pending,
      (SELECT COUNT(*) FROM assignments a WHERE a.event_id = e.id AND a.confirm_status = 'declined') AS crew_declined
    FROM events e WHERE e.date >= ? AND e.status != 'cancelled' ORDER BY e.date, e.soundcheck_time LIMIT 8`).all(today);
  const newLeads = db.prepare("SELECT * FROM leads WHERE status = 'new' ORDER BY id DESC LIMIT 10").all();
  const pipeline = db.prepare('SELECT status, COUNT(*) AS c FROM clients GROUP BY status').all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.c }), {});
  const owed = db.prepare(`SELECT COALESCE(SUM(COALESCE(a.agreed_price,0) - COALESCE(a.paid_amount,0)),0) AS s
    FROM assignments a JOIN events e ON e.id = a.event_id
    WHERE a.payment_status != 'paid' AND a.confirm_status != 'declined' AND e.status != 'cancelled'`).get().s;
  res.render('admin/dashboard', { upcoming, newLeads, pipeline, owed });
});

// ───────────────────────── Events
r.get('/events', (req, res) => {
  const view = req.query.view === 'past' ? 'past' : req.query.view === 'all' ? 'all' : 'upcoming';
  const today = todayIso();
  const where = view === 'past' ? 'WHERE e.date < ?' : view === 'all' ? 'WHERE ? = ?' : 'WHERE e.date >= ?';
  const params = view === 'all' ? [today, today] : [today];
  const events = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM assignments a WHERE a.event_id = e.id) AS crew_total,
      (SELECT COUNT(*) FROM assignments a WHERE a.event_id = e.id AND a.confirm_status = 'confirmed') AS crew_ok
    FROM events e ${where} ORDER BY e.date ${view === 'past' ? 'DESC' : 'ASC'}`).all(...params);
  res.render('admin/events', { events, view });
});

function readEventForm(b) {
  return {
    name: str(b.name) || 'אירוע',
    client_name: str(b.client_name),
    event_type: str(b.event_type),
    date: parseDate(str(b.date)) || todayIso(),
    venue: str(b.venue),
    address: str(b.address),
    arrival_time: timeOrNull(b.arrival_time),
    soundcheck_time: timeOrNull(b.soundcheck_time),
    reception_time: timeOrNull(b.reception_time),
    musicians_count: intOrNull(b.musicians_count),
    status: pick(b.status, labels.eventStatus, 'planning'),
    tech_requirements: str(b.tech_requirements),
    crew_notes: str(b.crew_notes),
    internal_notes: str(b.internal_notes),
    price: intOrNull(b.price),
  };
}

r.get('/events/new', (req, res) => res.render('admin/event-form', { ev: { status: 'planning', date: req.query.date || '' } }));

r.post('/events', (req, res) => {
  const ev = readEventForm(req.body);
  const info = db.prepare(`INSERT INTO events (name, client_name, event_type, date, venue, address, arrival_time,
      soundcheck_time, reception_time, musicians_count, status, tech_requirements, crew_notes, internal_notes, price)
    VALUES (@name, @client_name, @event_type, @date, @venue, @address, @arrival_time, @soundcheck_time,
      @reception_time, @musicians_count, @status, @tech_requirements, @crew_notes, @internal_notes, @price)`).run(ev);
  production.addDefaultTimeline(info.lastInsertRowid, ev);
  back(res, `/admin/events/${info.lastInsertRowid}`, 'האירוע נוצר');
});

function loadEvent(req, res, next) {
  const ev = production.getEvent(Number(req.params.id));
  if (!ev) return res.status(404).render('error', { title: 'לא נמצא', message: 'האירוע לא נמצא' });
  req.ev = ev;
  next();
}

r.get('/events/:id', loadEvent, (req, res) => {
  const ev = req.ev;
  const timeline = production.timelineFor(ev.id);
  const assignments = db.prepare(`SELECT a.*, c.name, c.phone, c.kind, c.role, c.token
    FROM assignments a JOIN crew c ON c.id = a.crew_id WHERE a.event_id = ?
    ORDER BY CASE c.kind WHEN 'musician' THEN 0 WHEN 'tech' THEN 1 ELSE 2 END, a.id`).all(ev.id);
  const available = db.prepare(`SELECT * FROM crew WHERE active = 1 AND id NOT IN (SELECT crew_id FROM assignments WHERE event_id = ?)
    ORDER BY kind, name`).all(ev.id);
  // who is already booked on the same date elsewhere
  const busy = new Set(db.prepare(`SELECT a.crew_id FROM assignments a JOIN events e ON e.id = a.event_id
    WHERE e.date = ? AND e.id != ? AND e.status != 'cancelled' AND a.confirm_status != 'declined'`).all(ev.date, ev.id).map((x) => x.crew_id));
  const client = ev.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(ev.client_id) : null;
  const totals = assignments.reduce((t, a) => {
    if (a.confirm_status === 'declined') return t;
    t.cost += a.agreed_price || 0;
    t.paid += a.payment_status === 'paid' ? (a.agreed_price || 0) : (a.paid_amount || 0);
    return t;
  }, { cost: 0, paid: 0 });
  res.render('admin/event', { ev, timeline, assignments, available, busy, client, totals });
});

r.get('/events/:id/edit', loadEvent, (req, res) => res.render('admin/event-form', { ev: req.ev }));

r.post('/events/:id', loadEvent, (req, res) => {
  const ev = readEventForm(req.body);
  const timeChanged = ev.date !== req.ev.date || ev.soundcheck_time !== req.ev.soundcheck_time || ev.arrival_time !== req.ev.arrival_time;
  db.prepare(`UPDATE events SET name=@name, client_name=@client_name, event_type=@event_type, date=@date, venue=@venue,
      address=@address, arrival_time=@arrival_time, soundcheck_time=@soundcheck_time, reception_time=@reception_time,
      musicians_count=@musicians_count, status=@status, tech_requirements=@tech_requirements, crew_notes=@crew_notes,
      internal_notes=@internal_notes, price=@price, updated_at=datetime('now') ${timeChanged ? ', reminder_sent_at = NULL' : ''}
    WHERE id=@id`).run({ ...ev, id: req.ev.id });
  if (timeChanged) db.prepare('UPDATE assignments SET alerted_at = NULL WHERE event_id = ?').run(req.ev.id);
  back(res, `/admin/events/${req.ev.id}`, 'נשמר');
});

r.post('/events/:id/status', loadEvent, (req, res) => {
  db.prepare("UPDATE events SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(pick(req.body.status, labels.eventStatus, req.ev.status), req.ev.id);
  back(res, `/admin/events/${req.ev.id}`, 'הסטטוס עודכן');
});

r.post('/events/:id/delete', loadEvent, (req, res) => {
  db.prepare('UPDATE clients SET event_id = NULL WHERE event_id = ?').run(req.ev.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(req.ev.id);
  back(res, '/admin/events', 'האירוע נמחק');
});

// Timeline (run sheet)
r.post('/events/:id/timeline', loadEvent, (req, res) => {
  const label = str(req.body.label);
  if (label) {
    const max = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM timeline_items WHERE event_id = ?').get(req.ev.id).m;
    db.prepare('INSERT INTO timeline_items (event_id, time, label, audience, sort) VALUES (?,?,?,?,?)')
      .run(req.ev.id, timeOrNull(req.body.time), label, pick(req.body.audience, labels.audience, 'all'), max + 10);
  }
  back(res, `/admin/events/${req.ev.id}#timeline`);
});

r.post('/events/:id/timeline/save', loadEvent, (req, res) => {
  const items = production.timelineFor(req.ev.id);
  const upd = db.prepare('UPDATE timeline_items SET time = ?, label = ?, audience = ?, sort = ? WHERE id = ? AND event_id = ?');
  const del = db.prepare('DELETE FROM timeline_items WHERE id = ? AND event_id = ?');
  db.transaction(() => {
    items.forEach((it) => {
      const f = (k) => req.body[`${k}_${it.id}`];
      if (f('delete')) return del.run(it.id, req.ev.id);
      upd.run(timeOrNull(f('time')), str(f('label')) || it.label, pick(f('audience'), labels.audience, it.audience),
        intOrNull(f('sort')) ?? it.sort, it.id, req.ev.id);
    });
  })();
  back(res, `/admin/events/${req.ev.id}#timeline`, 'הלו״ז נשמר');
});

// Assignments
r.post('/events/:id/assign', loadEvent, async (req, res) => {
  const ids = [].concat(req.body.crew_id || []).map(Number).filter(Boolean);
  const notify = req.body.notify === '1';
  const created = [];
  for (const crewId of ids) {
    const c = db.prepare('SELECT * FROM crew WHERE id = ?').get(crewId);
    if (!c) continue;
    try {
      const info = db.prepare('INSERT INTO assignments (event_id, crew_id, position, agreed_price) VALUES (?,?,?,?)')
        .run(req.ev.id, crewId, str(req.body.position) || c.role, intOrNull(req.body.agreed_price) ?? c.default_price);
      created.push(info.lastInsertRowid);
    } catch (e) { /* already assigned */ }
  }
  let failed = 0;
  if (notify) {
    for (const aid of created) {
      const r2 = await production.sendBookingMessage(aid);
      if (!r2.ok) failed += 1;
    }
  }
  const msg = `שובצו ${created.length}` + (notify ? (failed ? ` · ${failed} הודעות נכשלו` : ' · נשלחו הודעות שיבוץ') : '');
  back(res, `/admin/events/${req.ev.id}#crew`, msg);
});

function loadAssignment(req, res, next) {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND event_id = ?').get(Number(req.params.aid), Number(req.params.id));
  if (!a) return res.status(404).render('error', { title: 'לא נמצא', message: 'השיבוץ לא נמצא' });
  req.a = a;
  next();
}

r.post('/events/:id/assignments/:aid', loadAssignment, (req, res) => {
  const b = req.body;
  const confirm = pick(b.confirm_status, labels.confirmStatus, req.a.confirm_status);
  db.prepare(`UPDATE assignments SET position = ?, agreed_price = ?, payment_status = ?, paid_amount = ?,
      confirm_status = ?, notes = ?, responded_at = CASE WHEN ? != confirm_status THEN datetime('now') ELSE responded_at END
    WHERE id = ?`).run(str(b.position), intOrNull(b.agreed_price), pick(b.payment_status, labels.paymentStatus, req.a.payment_status),
    intOrNull(b.paid_amount), confirm, str(b.notes), confirm, req.a.id);
  back(res, `/admin/events/${req.params.id}#crew`, 'עודכן');
});

r.post('/events/:id/assignments/:aid/notify', loadAssignment, async (req, res) => {
  const out = await production.sendBookingMessage(req.a.id);
  back(res, `/admin/events/${req.params.id}#crew`, out.ok ? 'ההודעה נשלחה' : `שליחה נכשלה: ${out.error}`);
});

r.post('/events/:id/assignments/:aid/delete', loadAssignment, (req, res) => {
  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.a.id);
  back(res, `/admin/events/${req.params.id}#crew`, 'הוסר מהאירוע');
});

r.post('/events/:id/remind', loadEvent, async (req, res) => {
  const out = await production.sendEventReminder(req.ev.id);
  back(res, `/admin/events/${req.ev.id}`, `תזכורת נשלחה ל-${out.sent} מתוך ${out.total}`);
});

r.post('/events/:id/notify-pending', loadEvent, async (req, res) => {
  const pending = db.prepare("SELECT id FROM assignments WHERE event_id = ? AND confirm_status = 'pending'").all(req.ev.id);
  let ok = 0;
  for (const p of pending) if ((await production.sendBookingMessage(p.id)).ok) ok += 1;
  back(res, `/admin/events/${req.ev.id}#crew`, `נשלחו ${ok} הודעות שיבוץ`);
});

// ───────────────────────── Crew & suppliers
r.get('/crew', (req, res) => {
  const kind = labels.crewKind[req.query.kind] ? req.query.kind : null;
  const crew = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM assignments a JOIN events e ON e.id = a.event_id WHERE a.crew_id = c.id AND e.date >= date('now')) AS upcoming,
      (SELECT COALESCE(SUM(COALESCE(a.agreed_price,0) - CASE WHEN a.payment_status='paid' THEN COALESCE(a.agreed_price,0) ELSE COALESCE(a.paid_amount,0) END),0)
         FROM assignments a JOIN events e ON e.id = a.event_id WHERE a.crew_id = c.id AND a.confirm_status != 'declined' AND e.status != 'cancelled') AS owed
    FROM crew c ${kind ? 'WHERE c.kind = ?' : ''} ORDER BY c.active DESC, c.kind, c.name`).all(...(kind ? [kind] : []));
  res.render('admin/crew', { crew, kind });
});

function readCrewForm(b) {
  return {
    name: str(b.name) || 'ללא שם',
    kind: pick(b.kind, labels.crewKind, 'musician'),
    role: str(b.role),
    phone: str(b.phone),
    email: str(b.email),
    default_price: intOrNull(b.default_price),
    notes: str(b.notes),
    active: b.active === '0' ? 0 : 1,
  };
}

r.get('/crew/new', (req, res) => res.render('admin/crew-form', { c: { kind: req.query.kind || 'musician', active: 1 } }));

r.post('/crew', (req, res) => {
  const c = readCrewForm(req.body);
  const info = db.prepare(`INSERT INTO crew (name, kind, role, phone, email, default_price, notes, active, token)
    VALUES (@name, @kind, @role, @phone, @email, @default_price, @notes, @active, @token)`).run({ ...c, token: newToken() });
  back(res, `/admin/crew/${info.lastInsertRowid}`, 'נוסף למאגר');
});

function loadCrew(req, res, next) {
  const c = db.prepare('SELECT * FROM crew WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).render('error', { title: 'לא נמצא', message: 'איש הצוות לא נמצא' });
  req.c = c;
  next();
}

r.get('/crew/:id', loadCrew, (req, res) => {
  const history = db.prepare(`SELECT a.*, e.name AS event_name, e.date, e.status AS event_status
    FROM assignments a JOIN events e ON e.id = a.event_id WHERE a.crew_id = ? ORDER BY e.date DESC`).all(req.c.id);
  res.render('admin/crew-member', { c: req.c, history, link: production.crewLink(req.c) });
});

r.get('/crew/:id/edit', loadCrew, (req, res) => res.render('admin/crew-form', { c: req.c }));

r.post('/crew/:id', loadCrew, (req, res) => {
  db.prepare(`UPDATE crew SET name=@name, kind=@kind, role=@role, phone=@phone, email=@email,
    default_price=@default_price, notes=@notes, active=@active WHERE id=@id`).run({ ...readCrewForm(req.body), id: req.c.id });
  back(res, `/admin/crew/${req.c.id}`, 'נשמר');
});

r.post('/crew/:id/token', loadCrew, (req, res) => {
  db.prepare('UPDATE crew SET token = ? WHERE id = ?').run(newToken(), req.c.id);
  back(res, `/admin/crew/${req.c.id}`, 'נוצר קישור חדש — הקישור הקודם הפסיק לעבוד');
});

r.post('/crew/:id/delete', loadCrew, (req, res) => {
  const used = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE crew_id = ?').get(req.c.id).n;
  if (used) {
    db.prepare('UPDATE crew SET active = 0 WHERE id = ?').run(req.c.id);
    return back(res, `/admin/crew/${req.c.id}`, 'יש לו היסטוריית אירועים, לכן הוא הועבר ללא פעיל במקום להימחק');
  }
  db.prepare('DELETE FROM crew WHERE id = ?').run(req.c.id);
  back(res, '/admin/crew', 'נמחק');
});

// ───────────────────────── Payments overview
r.get('/payments', (req, res) => {
  const rows = db.prepare(`SELECT a.*, c.name, c.kind, e.name AS event_name, e.date, e.id AS event_id
    FROM assignments a JOIN crew c ON c.id = a.crew_id JOIN events e ON e.id = a.event_id
    WHERE a.confirm_status != 'declined' AND e.status != 'cancelled' AND ${req.query.all ? '1=1' : "a.payment_status != 'paid'"}
    ORDER BY e.date`).all();
  res.render('admin/payments', { rows, all: !!req.query.all });
});

// ───────────────────────── Leads
r.get('/leads', (req, res) => {
  const status = labels.leadStatus[req.query.status] ? req.query.status : 'new';
  const list = db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY id DESC LIMIT 300').all(status);
  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM leads GROUP BY status').all()
    .reduce((acc, x) => ({ ...acc, [x.status]: x.c }), {});
  res.render('admin/leads', { list, status, counts });
});

r.get('/leads/new', (req, res) => res.render('admin/lead-form', {}));

r.post('/leads', async (req, res) => {
  try {
    const id = await leads.createLead({ ...req.body, source: req.body.source || 'manual' }, { notify: req.body.notify === '1' });
    back(res, `/admin/leads/${id}`, 'הליד נקלט');
  } catch (e) {
    back(res, '/admin/leads/new', e.message);
  }
});

r.get('/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
  if (!lead) return res.status(404).render('error', { title: 'לא נמצא', message: 'הליד לא נמצא' });
  res.render('admin/lead', { lead });
});

r.post('/leads/:id/approve', async (req, res) => {
  const out = await leads.approveLead(Number(req.params.id));
  if (!out) return back(res, '/admin/leads', 'הליד לא נמצא');
  back(res, `/admin/clients/${out.clientId}`, out.already ? 'כבר קיים כרטיס לקוח' : 'נוצר כרטיס לקוח');
});

r.post('/leads/:id/reject', (req, res) => {
  leads.rejectLead(Number(req.params.id));
  back(res, '/admin/leads', 'סומן כלא רלוונטי');
});

r.post('/leads/:id/reopen', (req, res) => {
  db.prepare("UPDATE leads SET status = 'new', decided_at = NULL WHERE id = ? AND status = 'rejected'").run(Number(req.params.id));
  back(res, `/admin/leads/${req.params.id}`, 'הוחזר לממתינים');
});

r.post('/leads/:id/renotify', async (req, res) => {
  await leads.notifyManager(Number(req.params.id));
  back(res, `/admin/leads/${req.params.id}`, 'ההתראה נשלחה שוב');
});

// ───────────────────────── Clients (CRM)
r.get('/clients', (req, res) => {
  const status = labels.clientStatus[req.query.status] ? req.query.status : null;
  const q = str(req.query.q);
  const conds = [];
  const params = [];
  if (status) { conds.push('c.status = ?'); params.push(status); } else { conds.push("c.status NOT IN ('closed','lost')"); }
  if (q) { conds.push('(c.name LIKE ? OR c.phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const list = db.prepare(`SELECT c.*,
      (SELECT MAX(created_at) FROM interactions i WHERE i.client_id = c.id) AS last_touch
    FROM clients c WHERE ${conds.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 300`).all(...params);
  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM clients GROUP BY status').all()
    .reduce((acc, x) => ({ ...acc, [x.status]: x.c }), {});
  res.render('admin/clients', { list, status, counts, q });
});

function loadClient(req, res, next) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).render('error', { title: 'לא נמצא', message: 'הלקוח לא נמצא' });
  req.client = c;
  next();
}

r.get('/clients/:id', loadClient, (req, res) => {
  const history = db.prepare('SELECT * FROM interactions WHERE client_id = ? ORDER BY created_at DESC, id DESC').all(req.client.id);
  const lead = req.client.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(req.client.lead_id) : null;
  const ev = req.client.event_id ? production.getEvent(req.client.event_id) : null;
  res.render('admin/client', { client: req.client, history, lead, ev });
});

r.post('/clients/:id', loadClient, (req, res) => {
  const b = req.body;
  const status = pick(b.status, labels.clientStatus, req.client.status);
  db.prepare(`UPDATE clients SET name = ?, phone = ?, email = ?, requested_date = ?, event_type = ?, location = ?, notes = ?,
    status = ?, updated_at = datetime('now') WHERE id = ?`).run(str(b.name) || req.client.name, str(b.phone), str(b.email),
    parseDate(str(b.requested_date)), str(b.event_type), str(b.location), str(b.notes), status, req.client.id);
  if (status !== req.client.status) {
    db.prepare("INSERT INTO interactions (client_id, kind, summary) VALUES (?, 'system', ?)")
      .run(req.client.id, `סטטוס שונה: ${labels.clientStatus[req.client.status]} ← ${labels.clientStatus[status]}`);
  }
  back(res, `/admin/clients/${req.client.id}`, 'נשמר');
});

r.post('/clients/:id/status', loadClient, (req, res) => {
  const status = pick(req.body.status, labels.clientStatus, req.client.status);
  if (status !== req.client.status) {
    db.prepare("UPDATE clients SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.client.id);
    db.prepare("INSERT INTO interactions (client_id, kind, summary) VALUES (?, 'system', ?)")
      .run(req.client.id, `סטטוס שונה: ${labels.clientStatus[req.client.status]} ← ${labels.clientStatus[status]}`);
  }
  back(res, `/admin/clients/${req.client.id}`);
});

r.post('/clients/:id/interactions', loadClient, (req, res) => {
  const kind = pick(req.body.kind, labels.interactionKind, 'note');
  const summary = str(req.body.summary);
  const amount = intOrNull(req.body.amount);
  if (summary || amount) {
    db.prepare('INSERT INTO interactions (client_id, kind, summary, amount) VALUES (?,?,?,?)').run(req.client.id, kind, summary, amount);
    if (kind === 'quote' && ['new_lead'].includes(req.client.status)) {
      db.prepare("UPDATE clients SET status = 'quote_sent' WHERE id = ?").run(req.client.id);
    }
    touch('clients', req.client.id);
  }
  back(res, `/admin/clients/${req.client.id}#history`, 'נוסף להיסטוריה');
});

r.post('/clients/:id/interactions/:iid/delete', loadClient, (req, res) => {
  db.prepare("DELETE FROM interactions WHERE id = ? AND client_id = ? AND kind != 'system'").run(Number(req.params.iid), req.client.id);
  back(res, `/admin/clients/${req.client.id}#history`);
});

r.post('/clients/:id/convert', loadClient, (req, res) => {
  const eventId = leads.convertClientToEvent(req.client.id);
  back(res, `/admin/events/${eventId}`, 'נפתח אירוע חדש במערכת ההפקה — השלם את הפרטים');
});

// ───────────────────────── Users (managers)
r.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, name, phone, created_at FROM managers ORDER BY id').all();
  res.render('admin/users', { users, error: null, values: {} });
});

r.post('/users', (req, res) => {
  const b = req.body;
  const username = String(b.username || '').trim().toLowerCase();
  const fail = (error) => res.status(400).render('admin/users', {
    users: db.prepare('SELECT id, username, name, phone, created_at FROM managers ORDER BY id').all(), error, values: b,
  });
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return fail('שם משתמש: 3–32 תווים באנגלית, ספרות או . _ -');
  if (String(b.password || '').length < 8) return fail('סיסמה: לפחות 8 תווים');
  if (db.prepare('SELECT 1 FROM managers WHERE username = ?').get(username)) return fail('שם המשתמש כבר קיים');
  db.prepare('INSERT INTO managers (username, name, phone, password_hash) VALUES (?,?,?,?)')
    .run(username, str(b.name) || username, str(b.phone), bcrypt.hashSync(String(b.password), 10));
  back(res, '/admin/users', `המשתמש ${username} נוסף`);
});

function loadUser(req, res, next) {
  const m = db.prepare('SELECT * FROM managers WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).render('error', { title: 'לא נמצא', message: 'המשתמש לא נמצא' });
  req.user = m;
  next();
}

r.post('/users/:id', loadUser, (req, res) => {
  db.prepare('UPDATE managers SET name = ?, phone = ? WHERE id = ?')
    .run(str(req.body.name) || req.user.name, str(req.body.phone), req.user.id);
  back(res, '/admin/users', 'נשמר');
});

r.post('/users/:id/password', loadUser, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return back(res, '/admin/users', 'סיסמה: לפחות 8 תווים');
  db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), req.user.id);
  back(res, '/admin/users', `הסיסמה של ${req.user.username} עודכנה`);
});

r.post('/users/:id/delete', loadUser, (req, res) => {
  if (req.user.id === req.manager.id) return back(res, '/admin/users', 'אי אפשר למחוק את המשתמש שאיתו נכנסת');
  db.prepare('DELETE FROM managers WHERE id = ?').run(req.user.id);
  back(res, '/admin/users', `המשתמש ${req.user.username} נמחק`);
});

// ───────────────────────── Messages log & automations
r.get('/messages', (req, res) => {
  const list = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all();
  res.render('admin/messages', { list });
});

r.post('/automations/run', async (req, res) => {
  const out = await scheduler.runOnce();
  back(res, '/admin/messages', `הבדיקה הורצה: ${out.reminders ? out.reminders.length : 0} תזכורות, ${out.alerts ? out.alerts.length : 0} התראות`);
});

module.exports = r;

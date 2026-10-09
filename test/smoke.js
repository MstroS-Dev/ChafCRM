/* End-to-end smoke test: boots the app on a temp DB and walks every main flow. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chafcrm-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-pass';
process.env.MANAGER_PHONE = '050-1111111';
process.env.WEBHOOK_KEY = 'hook';
process.env.WHATSAPP_PROVIDER = 'log';
process.env.TZ = 'Asia/Jerusalem';
const origLog = console.log;
console.log = () => {}; // keep output readable (messages are logged in log mode)

const app = require('../src/server');
const { db } = require('../src/db');
const scheduler = require('../src/scheduler');

let base;
let cookie = '';

async function req(method, url, { form, json, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  let body;
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text, setCookie: res.headers.get('set-cookie') };
}

function isoIn(hours) {
  const d = new Date(Date.now() + hours * 3600e3);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

(async () => {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const ok = (name) => origLog(`  ✓ ${name}`);

  // ── auth
  let r = await req('GET', '/admin');
  assert.strictEqual(r.status, 302); assert.match(r.location, /\/login/);
  r = await req('POST', '/login', { form: { username: 'admin', password: 'nope' } });
  assert.strictEqual(r.status, 401);
  r = await req('POST', '/login', { form: { username: 'admin', password: 'test-pass', next: '/admin' } });
  assert.strictEqual(r.status, 302); cookie = r.setCookie.split(';')[0];
  r = await req('GET', '/admin'); assert.strictEqual(r.status, 200);
  ok('manager login & protected admin');

  // ── crew
  for (const [name, kind, role, price, phone] of [
    ['אבי לוי', 'musician', 'תופים', 900, '052-2222222'],
    ['דנה כהן', 'musician', 'בס', 800, '052-3333333'],
    ['סאונד פלוס', 'supplier', 'ספק הגברה', 4000, '052-4444444'],
  ]) {
    r = await req('POST', '/admin/crew', { form: { name, kind, role, default_price: price, phone } });
    assert.strictEqual(r.status, 302);
  }
  const crew = db.prepare('SELECT * FROM crew ORDER BY id').all();
  assert.strictEqual(crew.length, 3);
  ok('crew & suppliers created');

  // ── event 30h from now (soundcheck) -> inside 48h, outside 24h
  const sc = isoIn(30);
  r = await req('POST', '/admin/events', { form: {
    name: 'חתונה – בדיקה', event_type: 'חתונה', date: sc.date, venue: 'אולם הגן', address: 'הרצל 1 ראשון לציון',
    arrival_time: '', soundcheck_time: sc.time, reception_time: '', status: 'approved', price: '25000',
    tech_requirements: '2 מוניטורים', crew_notes: 'לבוש שחור', internal_notes: 'סוד פנימי', musicians_count: '5',
  } });
  assert.strictEqual(r.status, 302);
  const ev = db.prepare('SELECT * FROM events').get();
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM timeline_items WHERE event_id = ?').get(ev.id).c, 6);
  r = await req('POST', `/admin/events/${ev.id}/timeline`, { form: { time: '21:00', label: 'כניסת ציוד הגברה', audience: 'suppliers' } });
  ok('event created with default run sheet');

  // ── assign all + booking messages
  const body = new URLSearchParams(); crew.forEach((c) => body.append('crew_id', c.id)); body.append('notify', '1');
  r = await fetch(`${base}/admin/events/${ev.id}/assign`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'manual' });
  const asg = db.prepare('SELECT * FROM assignments WHERE event_id = ? ORDER BY id').all(ev.id);
  assert.strictEqual(asg.length, 3);
  assert.ok(asg.every((a) => a.notified_at), 'all notified');
  const booking = db.prepare("SELECT * FROM messages WHERE ref LIKE 'assignment:%'").all();
  assert.strictEqual(booking.length, 3);
  assert.match(booking[0].body, /מאשר/);
  assert.strictEqual(asg[0].agreed_price, 900, 'default price applied');
  ok('assignments + booking WhatsApp messages with confirm link');

  // ── crew view: access separation
  const drummer = crew[0];
  const supplier = crew[2];
  r = await req('GET', `/c/${drummer.token}`, { auth: false });
  assert.strictEqual(r.status, 200); assert.match(r.text, /חתונה – בדיקה/);
  r = await req('GET', `/c/${drummer.token}/a/${asg[0].id}`, { auth: false });
  assert.strictEqual(r.status, 200);
  for (const secret of ['₪25', '25000', 'סוד פנימי', '₪900', 'כניסת ציוד הגברה', '2 מוניטורים']) {
    assert.ok(!r.text.includes(secret), `musician must not see "${secret}"`);
  }
  assert.match(r.text, /לבוש שחור/); assert.match(r.text, /waze\.com/);
  r = await req('GET', `/c/${supplier.token}/a/${asg[2].id}`, { auth: false });
  assert.match(r.text, /2 מוניטורים/); assert.match(r.text, /כניסת ציוד הגברה/);
  assert.ok(!r.text.includes('4,000') && !r.text.includes('סוד פנימי'));
  r = await req('GET', `/c/${drummer.token}/a/${asg[2].id}`, { auth: false });
  assert.strictEqual(r.status, 404, 'cannot open someone else\'s assignment');
  r = await req('GET', '/admin', { auth: false });
  assert.strictEqual(r.status, 302, 'crew link gives no admin access');
  r = await req('GET', '/c/not-a-token', { auth: false });
  assert.strictEqual(r.status, 404);
  ok('crew/supplier views show only what they should (no finance, no internal notes)');

  // ── confirm via link, decline via WhatsApp text reply
  r = await req('POST', `/c/${drummer.token}/a/${asg[0].id}/respond`, { auth: false, form: { answer: 'confirmed' } });
  assert.strictEqual(db.prepare('SELECT confirm_status FROM assignments WHERE id = ?').get(asg[0].id).confirm_status, 'confirmed');
  r = await req('POST', '/webhooks/greenapi?key=hook', { auth: false, json: {
    typeWebhook: 'incomingMessageReceived',
    senderData: { chatId: '972523333333@c.us', senderName: 'Dana' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'לא מאשרת, סליחה' } },
  } });
  await new Promise((s) => setTimeout(s, 100));
  assert.strictEqual(db.prepare('SELECT confirm_status FROM assignments WHERE id = ?').get(asg[1].id).confirm_status, 'declined');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM messages WHERE ref = ?").get(`declined:${asg[1].id}`).c === 1, 'manager told about decline');
  ok('confirm by link, decline by WhatsApp reply (+ manager notified)');

  // ── scheduler: 48h alert for supplier still pending; no 24h reminder yet
  let out = await scheduler.runOnce();
  assert.strictEqual(out.reminders.length, 0);
  assert.strictEqual(out.alerts.length, 1);
  const alert = db.prepare("SELECT * FROM messages WHERE ref = ?").get(`unconfirmed:${ev.id}`);
  assert.match(alert.body, /סאונד פלוס/); assert.ok(!alert.body.includes('אבי לוי'));
  out = await scheduler.runOnce();
  assert.strictEqual(out.alerts.length, 0, 'alert not repeated');
  // move soundcheck to 20h from now -> reminder fires
  const sc2 = isoIn(20);
  db.prepare('UPDATE events SET date = ?, soundcheck_time = ? WHERE id = ?').run(sc2.date, sc2.time, ev.id);
  out = await scheduler.runOnce();
  assert.strictEqual(out.reminders.length, 1);
  assert.strictEqual(out.reminders[0].sent, 2, 'declined member not reminded');
  const rem = db.prepare("SELECT body FROM messages WHERE ref = ?").get(`reminder:${asg[0].id}`).body;
  assert.match(rem, /waze\.com/); assert.match(rem, /לו״ז/);
  out = await scheduler.runOnce();
  assert.strictEqual(out.reminders.length, 0, 'reminder not repeated');
  ok('automations: 48h unconfirmed alert, 24h reminder with Waze + run sheet, no duplicates');

  // ── leads: public form -> manager notified -> approve via signed link
  r = await req('POST', '/apply', { auth: false, form: { name: 'ישראל ישראלי', phone: '050-0000000', requested_date: '2026-11-15', event_type: 'חתונה', location: 'תל אביב' } });
  assert.strictEqual(r.status, 302);
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC').get();
  const leadMsg = db.prepare('SELECT body FROM messages WHERE ref = ?').get(`lead:${lead.id}`).body;
  assert.match(leadMsg, /ליד חדש נכנס/); assert.match(leadMsg, /15\/11\/2026/);
  const link = leadMsg.match(/https?:\/\/\S+\/l\/\d+\/\S+/)[0].replace(/^https?:\/\/[^/]+/, '');
  r = await req('GET', link, { auth: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'new', 'GET (link preview) does not act');
  r = await req('POST', link.replace(/.$/, 'x'), { auth: false, form: { action: 'approve' } });
  assert.strictEqual(r.status, 403, 'tampered link rejected');
  r = await req('POST', link, { auth: false, form: { action: 'approve' } });
  const lead2 = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
  assert.strictEqual(lead2.status, 'approved'); assert.ok(lead2.client_id);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM messages WHERE ref = ?').get(`client-ack:${lead2.client_id}`).c === 1, 'client auto-reply');
  r = await req('POST', link, { auth: false, form: { action: 'approve' } });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 1, 'idempotent');
  ok('lead form → manager WhatsApp → approve link → client card + auto-reply');

  // ── reject flow + webhook lead + WhatsApp lead + duplicate guard
  r = await req('POST', '/webhooks/lead?key=bad', { auth: false, json: { name: 'x', phone: '1' } });
  assert.strictEqual(r.status, 401);
  r = await req('POST', '/webhooks/lead?key=hook', { auth: false, json: { full_name: 'אינסטה', phone_number: '054-5555555', source: 'instagram', event_date: '01/12/2026' } });
  const igLead = JSON.parse(r.text);
  assert.ok(igLead.ok);
  assert.strictEqual(db.prepare('SELECT requested_date FROM leads WHERE id = ?').get(igLead.id).requested_date, '2026-12-01');
  r = await req('POST', `/admin/leads/${igLead.id}/reject`);
  assert.strictEqual(db.prepare('SELECT status FROM leads WHERE id = ?').get(igLead.id).status, 'rejected');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 1, 'no client on reject');
  const waMsg = { typeWebhook: 'incomingMessageReceived', senderData: { chatId: '972546666666@c.us', senderName: 'Moshe' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'היי, מה המחיר לחתונה?' } } };
  await req('POST', '/webhooks/greenapi?key=hook', { auth: false, json: waMsg });
  await req('POST', '/webhooks/greenapi?key=hook', { auth: false, json: waMsg });
  await new Promise((s) => setTimeout(s, 100));
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM leads WHERE source = 'whatsapp'").get().c, 1, 'one lead per WhatsApp contact');
  ok('reject, webhook (Make/Instagram) lead, WhatsApp lead with duplicate guard');

  // ── client card: history, quote, convert to event
  const clientId = lead2.client_id;
  await req('POST', `/admin/clients/${clientId}/interactions`, { form: { kind: 'quote', amount: '18000', summary: 'הרכב 5 נגנים' } });
  assert.strictEqual(db.prepare('SELECT status FROM clients WHERE id = ?').get(clientId).status, 'quote_sent');
  await req('POST', `/admin/clients/${clientId}/status`, { form: { status: 'negotiation' } });
  r = await req('POST', `/admin/clients/${clientId}/convert`);
  const c2 = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  assert.strictEqual(c2.status, 'closed'); assert.ok(c2.event_id);
  const ev2 = db.prepare('SELECT * FROM events WHERE id = ?').get(c2.event_id);
  assert.strictEqual(ev2.date, '2026-11-15'); assert.strictEqual(ev2.price, 18000); assert.strictEqual(ev2.client_id, clientId);
  ok('client card: quote → status pipeline → convert to production event');

  // ── users: add a manager, log in as them, protections
  r = await req('POST', '/admin/users', { form: { username: 'Producer', name: 'מנהל הפקה', password: 'short' } });
  assert.strictEqual(r.status, 400, 'short password rejected');
  r = await req('POST', '/admin/users', { form: { username: 'Producer', name: 'מנהל הפקה', password: 'producer-pass', phone: '050-9999999' } });
  assert.strictEqual(r.status, 302);
  const prod = db.prepare("SELECT * FROM managers WHERE username = 'producer'").get();
  assert.ok(prod, 'username stored lowercase');
  r = await req('POST', '/admin/users', { form: { username: 'producer', password: 'another-pass' } });
  assert.strictEqual(r.status, 400, 'duplicate rejected');
  const adminCookie = cookie;
  r = await req('POST', '/login', { auth: false, form: { username: 'producer', password: 'producer-pass' } });
  cookie = r.setCookie.split(';')[0];
  r = await req('GET', '/admin'); assert.strictEqual(r.status, 200, 'new manager can log in');
  r = await req('POST', `/admin/users/${prod.id}/delete`);
  assert.ok(db.prepare('SELECT 1 FROM managers WHERE id = ?').get(prod.id), 'cannot delete yourself');
  cookie = adminCookie;
  r = await req('POST', `/admin/users/${prod.id}/password`, { form: { password: 'changed-pass' } });
  r = await req('POST', '/login', { auth: false, form: { username: 'producer', password: 'changed-pass' } });
  assert.strictEqual(r.status, 302, 'password change works');
  r = await req('POST', `/admin/users/${prod.id}/delete`);
  assert.ok(!db.prepare('SELECT 1 FROM managers WHERE id = ?').get(prod.id), 'admin can delete another user');
  ok('users: add manager, login, change password, delete (not self)');

  // ── every admin page renders
  for (const p of ['/admin', '/admin/events', '/admin/events?view=all', `/admin/events/${ev.id}`, `/admin/events/${ev.id}/edit`, '/admin/events/new',
    '/admin/crew', `/admin/crew/${drummer.id}`, `/admin/crew/${drummer.id}/edit`, '/admin/crew/new', '/admin/payments', '/admin/payments?all=1',
    '/admin/leads', '/admin/leads?status=approved', '/admin/leads?status=rejected', '/admin/leads/new', `/admin/leads/${lead.id}`,
    '/admin/clients', '/admin/clients?status=closed', `/admin/clients/${clientId}`, '/admin/messages', '/admin/users']) {
    r = await req('GET', p);
    assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
  }
  for (const p of ['/apply', '/apply?embed=1', '/login', '/healthz']) {
    r = await req('GET', p, { auth: false });
    assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
  }
  ok('all pages render');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  origLog('\nAll smoke tests passed.');
  process.exit(0);
})().catch((e) => {
  origLog('\n✗ FAILED:', e.message);
  console.error(e);
  process.exit(1);
});

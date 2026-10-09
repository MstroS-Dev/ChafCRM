const express = require('express');
const { db } = require('../db');
const config = require('../config');
const auth = require('../auth');
const leads = require('../services/leads');

const r = express.Router();

r.get('/', (req, res) => res.redirect(auth.readSession(req) ? '/admin' : '/login'));

// ───────────── Manager login
r.get('/login', (req, res) => {
  if (auth.readSession(req)) return res.redirect('/admin');
  const hasManagers = db.prepare('SELECT COUNT(*) AS c FROM managers').get().c > 0;
  res.render('public/login', { error: null, next: req.query.next || '/admin', hasManagers });
});

r.post('/login', (req, res) => {
  const key = req.ip;
  const nextUrl = String(req.body.next || '/admin');
  const safeNext = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/admin';
  const hasManagers = true;
  if (auth.tooManyAttempts(key)) {
    return res.status(429).render('public/login', { error: 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות.', next: safeNext, hasManagers });
  }
  const m = auth.login(req.body.username, req.body.password);
  if (!m) {
    auth.recordFailure(key);
    return res.status(401).render('public/login', { error: 'שם משתמש או סיסמה שגויים', next: safeNext, hasManagers });
  }
  auth.issueSession(res, m.id);
  res.redirect(safeNext);
});

r.post('/logout', (req, res) => {
  auth.clearSession(res);
  res.redirect('/login');
});

// ───────────── Public lead form (link from website / Instagram bio, or embed in an iframe)
r.get('/apply', (req, res) => {
  res.render('public/apply', { sent: req.query.sent === '1', error: null, values: {}, embed: req.query.embed === '1' });
});

r.post('/apply', async (req, res) => {
  const b = req.body;
  const embed = b.embed === '1';
  if (b.website) return res.redirect('/apply?sent=1'); // honeypot: bots fill hidden field
  if (!b.name || !b.phone) {
    return res.status(400).render('public/apply', { sent: false, error: 'נא למלא שם וטלפון', values: b, embed });
  }
  try {
    const source = ['instagram', 'facebook', 'form'].includes(b.source) ? b.source : 'form';
    await leads.createLead({ ...b, source });
  } catch (e) {
    return res.status(400).render('public/apply', { sent: false, error: e.message, values: b, embed });
  }
  res.redirect(`/apply?sent=1${embed ? '&embed=1' : ''}`);
});

// ───────────── One-tap lead decision from the manager's WhatsApp
// GET shows a confirmation page (so WhatsApp link previews can't trigger anything); POST acts.
function loadSignedLead(req, res, next) {
  const id = Number(req.params.id);
  if (!auth.verifyAction('lead', id, req.params.sig)) {
    return res.status(403).render('error', { title: 'קישור לא תקין', message: 'הקישור פג או שגוי.' });
  }
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) return res.status(404).render('error', { title: 'לא נמצא', message: 'הליד לא נמצא' });
  req.lead = lead;
  next();
}

r.get('/l/:id/:sig', loadSignedLead, (req, res) => {
  res.render('public/lead-decision', { lead: req.lead, sig: req.params.sig, result: req.query.result || null });
});

r.post('/l/:id/:sig', loadSignedLead, async (req, res) => {
  const lead = req.lead;
  if (req.body.action === 'approve') {
    const out = await leads.approveLead(lead.id);
    if (auth.readSession(req)) return res.redirect(`/admin/clients/${out.clientId}?msg=${encodeURIComponent('נוצר כרטיס לקוח')}`);
    return res.redirect(`/l/${lead.id}/${req.params.sig}?result=approved`);
  }
  if (req.body.action === 'reject') {
    leads.rejectLead(lead.id);
    return res.redirect(`/l/${lead.id}/${req.params.sig}?result=rejected`);
  }
  res.redirect(`/l/${lead.id}/${req.params.sig}`);
});

r.get('/healthz', (req, res) => res.json({ ok: true, brand: config.brand }));

module.exports = r;

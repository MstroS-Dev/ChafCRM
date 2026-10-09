/**
 * Personal, password-less pages for musicians, technicians and suppliers.
 * Access is by a secret per-person link (/c/<token>). Only crew-safe fields are shown —
 * never prices, payments, client contacts, leads or internal notes.
 */
const express = require('express');
const { db } = require('../db');
const production = require('../services/production');

const r = express.Router();

function loadCrew(req, res, next) {
  const c = db.prepare('SELECT id, name, kind, role, token, active FROM crew WHERE token = ?').get(req.params.token);
  if (!c || !c.active) {
    return res.status(404).render('error', { title: 'הקישור אינו פעיל', message: 'פנה/י למנהל ההפקה לקבלת קישור חדש.' });
  }
  req.crew = c;
  res.locals.crew = c;
  res.set('X-Robots-Tag', 'noindex');
  next();
}

r.get('/:token', loadCrew, (req, res) => {
  const rows = db.prepare(`SELECT a.id AS assignment_id, a.position, a.confirm_status, e.*
    FROM assignments a JOIN events e ON e.id = a.event_id
    WHERE a.crew_id = ? AND e.status != 'cancelled' AND e.date >= date('now', '-1 day')
    ORDER BY e.date, e.soundcheck_time`).all(req.crew.id);
  const items = rows.map((row) => ({
    ...production.crewView(row, req.crew.kind),
    assignment_id: row.assignment_id,
    position: row.position,
    confirm_status: row.confirm_status,
  }));
  res.render('crew/home', { items });
});

r.get('/:token/a/:aid', loadCrew, (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND crew_id = ?').get(Number(req.params.aid), req.crew.id);
  if (!a) return res.status(404).render('error', { title: 'לא נמצא', message: 'השיבוץ לא נמצא' });
  const ev = production.getEvent(a.event_id);
  const view = production.crewView(ev, req.crew.kind);
  const team = db.prepare(`SELECT c.name, a.position FROM assignments a JOIN crew c ON c.id = a.crew_id
    WHERE a.event_id = ? AND a.confirm_status = 'confirmed' AND c.kind != 'supplier' ORDER BY a.id`).all(ev.id);
  res.render('crew/event', { a, ev: view, team, done: req.query.done });
});

r.post('/:token/a/:aid/respond', loadCrew, async (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND crew_id = ?').get(Number(req.params.aid), req.crew.id);
  if (!a) return res.status(404).render('error', { title: 'לא נמצא', message: 'השיבוץ לא נמצא' });
  const answer = req.body.answer === 'confirmed' ? 'confirmed' : 'declined';
  await production.respond(a.id, answer);
  res.redirect(`/c/${req.crew.token}/a/${a.id}?done=${answer}`);
});

module.exports = r;

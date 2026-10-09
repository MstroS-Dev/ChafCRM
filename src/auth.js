const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');

const COOKIE = 'chaf_session';
const SESSION_DAYS = 30;

function hmac(value) {
  return crypto.createHmac('sha256', config.secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Signed token for one-tap links (e.g. manager approving a lead from WhatsApp). */
function signAction(scope, id) {
  return hmac(`${scope}:${id}`).slice(0, 24);
}
function verifyAction(scope, id, sig) {
  return !!sig && safeEqual(signAction(scope, id), sig);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function issueSession(res, managerId) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  const payload = `${managerId}.${exp}`;
  const value = `${payload}.${hmac(payload)}`;
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [id, exp, sig] = raw.split('.');
  if (!id || !exp || !sig) return null;
  if (!safeEqual(hmac(`${id}.${exp}`), sig)) return null;
  if (Number(exp) < Date.now()) return null;
  return db.prepare('SELECT id, username, name, phone FROM managers WHERE id = ?').get(Number(id)) || null;
}

// Simple in-memory brute-force protection for the login form
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (a.until > now) return true;
  if (now - a.first > 15 * 60e3) attempts.delete(key);
  return false;
}
function recordFailure(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  a.n += 1;
  if (a.n >= 8) { a.until = now + 15 * 60e3; a.n = 0; a.first = now; }
  attempts.set(key, a);
}

function login(username, password) {
  const m = db.prepare('SELECT * FROM managers WHERE username = ?').get(String(username || '').trim());
  if (!m) return null;
  return bcrypt.compareSync(String(password || ''), m.password_hash) ? m : null;
}

function requireManager(req, res, next) {
  const manager = readSession(req);
  if (!manager) {
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${nextUrl}`);
  }
  req.manager = manager;
  res.locals.manager = manager;
  next();
}

module.exports = {
  signAction, verifyAction, issueSession, clearSession, readSession,
  login, requireManager, tooManyAttempts, recordFailure, safeEqual,
};

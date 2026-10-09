const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS managers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Musicians, technicians and external suppliers
CREATE TABLE IF NOT EXISTS crew (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'musician' CHECK (kind IN ('musician','tech','supplier')),
  role TEXT,                 -- e.g. גיטרה, טכנאי סאונד, ספק הגברה, DJ
  phone TEXT,
  email TEXT,
  default_price INTEGER,
  notes TEXT,
  token TEXT NOT NULL UNIQUE, -- personal access link
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  requested_date TEXT,
  event_type TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'new_lead'
    CHECK (status IN ('new_lead','quote_sent','negotiation','closed','lost')),
  notes TEXT,
  event_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  client_name TEXT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  event_type TEXT,
  date TEXT NOT NULL,            -- YYYY-MM-DD
  venue TEXT,
  address TEXT,
  arrival_time TEXT,            -- HH:MM
  soundcheck_time TEXT,
  reception_time TEXT,
  musicians_count INTEGER,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','approved','done','cancelled')),
  tech_requirements TEXT,       -- visible to suppliers
  crew_notes TEXT,              -- highlights visible to all assigned crew
  internal_notes TEXT,          -- manager only
  price INTEGER,                -- manager only
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timeline_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  time TEXT,
  label TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','musicians','suppliers')),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  crew_id INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  position TEXT,                -- role in this event: תופים, בס...
  confirm_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (confirm_status IN ('pending','confirmed','declined')),
  agreed_price INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','deposit','paid')),
  paid_amount INTEGER,
  notes TEXT,
  notified_at TEXT,
  responded_at TEXT,
  alerted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, crew_id)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT,
  email TEXT,
  requested_date TEXT,
  event_type TEXT,
  location TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'form', -- form / whatsapp / instagram / facebook / manual / webhook
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','rejected')),
  client_id INTEGER,
  manager_notified_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','call','quote','whatsapp','meeting','system')),
  summary TEXT,
  amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  recipient TEXT,
  body TEXT,
  status TEXT NOT NULL,         -- sent / logged / failed / received
  error TEXT,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_assign_event ON assignments(event_id);
CREATE INDEX IF NOT EXISTS idx_assign_crew ON assignments(crew_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_crew_phone ON crew(phone);
`);

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function seedManager() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM managers').get().c;
  const { username, password, name, phone } = config.admin;
  if (count === 0) {
    if (!password) {
      console.warn('[setup] No managers yet. Set ADMIN_PASSWORD to create the first manager account.');
      return;
    }
    db.prepare('INSERT INTO managers (username, name, phone, password_hash) VALUES (?,?,?,?)')
      .run(username, name, phone, bcrypt.hashSync(password, 10));
    console.log(`[setup] Created manager "${username}".`);
  } else if (password && process.env.ADMIN_PASSWORD_RESET === '1') {
    db.prepare('UPDATE managers SET password_hash = ? WHERE username = ?')
      .run(bcrypt.hashSync(password, 10), username);
    console.log(`[setup] Reset password for "${username}".`);
  }
}
seedManager();

function touch(table, id) {
  db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

module.exports = { db, newToken, touch };

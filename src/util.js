const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** "2026-11-15" -> "15/11/2026" */
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!d) return iso;
  return `${d}/${m}/${y}`;
}

/** "2026-11-15" -> "יום ראשון, 15/11/2026" */
function fmtDateLong(iso) {
  if (!iso) return '';
  const dt = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return fmtDate(iso);
  return `יום ${DAYS[dt.getDay()]}, ${fmtDate(iso)}`;
}

/** Local Date for an event's date + "HH:MM" (server runs in the business time zone). */
function eventMoment(date, time) {
  if (!date) return null;
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time.padStart(5, '0') : '00:00';
  const dt = new Date(`${date}T${t}:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** The time crew should be counting from: soundcheck, else arrival, else reception, else midnight. */
function eventStart(ev) {
  return eventMoment(ev.date, ev.soundcheck_time || ev.arrival_time || ev.reception_time);
}

/** Accepts DD/MM/YYYY, D.M.YY, YYYY-MM-DD; returns YYYY-MM-DD or the original text. */
function parseDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return s;
}

function wazeLink(ev) {
  const q = [ev.venue, ev.address].filter(Boolean).join(', ');
  if (!q) return '';
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
}

function money(n) {
  if (n === null || n === undefined || n === '') return '';
  return `₪${Number(n).toLocaleString('he-IL')}`;
}

function intOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function timeOrNull(v) {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sqlNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = {
  fmtDate, fmtDateLong, eventMoment, eventStart, parseDate, wazeLink, money,
  intOrNull, str, timeOrNull, todayIso, sqlNow,
};

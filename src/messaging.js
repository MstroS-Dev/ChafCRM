/**
 * Outgoing messages: WhatsApp (Green API / Twilio) and Telegram.
 * Every message is recorded in the `messages` table so the manager can see
 * what was sent, including in "log" mode where nothing leaves the server.
 */
const config = require('./config');
const { db } = require('./db');

/** "050-123 4567" -> "972501234567" (digits only, international, no +) */
function normalizePhone(phone) {
  if (!phone) return '';
  let d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return config.whatsapp.countryCode + d.slice(1);
  return d;
}

function record(channel, recipient, body, status, error, ref) {
  db.prepare('INSERT INTO messages (channel, recipient, body, status, error, ref) VALUES (?,?,?,?,?,?)')
    .run(channel, recipient || '', body || '', status, error || null, ref || null);
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function sendWhatsApp(phone, text, ref) {
  const to = normalizePhone(phone);
  const provider = config.whatsapp.provider;
  if (!to) {
    record('whatsapp', phone, text, 'failed', 'missing phone number', ref);
    return { ok: false, error: 'missing phone number' };
  }
  try {
    if (provider === 'greenapi') {
      const { url, idInstance, token } = config.whatsapp.greenApi;
      if (!idInstance || !token) throw new Error('Green API is not configured');
      await postJson(`${url}/waInstance${idInstance}/sendMessage/${token}`, {
        chatId: `${to}@c.us`,
        message: text,
        linkPreview: false,
      });
    } else if (provider === 'twilio') {
      const { accountSid, authToken, from } = config.whatsapp.twilio;
      if (!accountSid || !authToken || !from) throw new Error('Twilio is not configured');
      const isWa = from.startsWith('whatsapp:');
      const form = new URLSearchParams({
        From: from,
        To: isWa ? `whatsapp:+${to}` : `+${to}`,
        Body: text,
      });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });
      if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } else {
      console.log(`[whatsapp:log] -> ${to}\n${text}\n`);
      record('whatsapp', to, text, 'logged', null, ref);
      return { ok: true, logged: true };
    }
    record('whatsapp', to, text, 'sent', null, ref);
    return { ok: true };
  } catch (err) {
    console.error('[whatsapp] send failed:', err.message);
    record('whatsapp', to, text, 'failed', err.message, ref);
    return { ok: false, error: err.message };
  }
}

/**
 * Telegram message, optionally with inline buttons:
 * buttons = [[{ text, callback_data } | { text, url }]]
 */
async function sendTelegram(text, buttons, ref) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    record('telegram', chatId, text, 'failed', 'Telegram is not configured', ref);
    return { ok: false, error: 'Telegram is not configured' };
  }
  try {
    const body = { chat_id: chatId, text, disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    await postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, body);
    record('telegram', chatId, text, 'sent', null, ref);
    return { ok: true };
  } catch (err) {
    console.error('[telegram] send failed:', err.message);
    record('telegram', chatId, text, 'failed', err.message, ref);
    return { ok: false, error: err.message };
  }
}

async function telegramApi(method, body) {
  const { botToken } = config.telegram;
  if (!botToken) return null;
  try {
    return await postJson(`https://api.telegram.org/bot${botToken}/${method}`, body);
  } catch (err) {
    console.error(`[telegram] ${method} failed:`, err.message);
    return null;
  }
}

/** Send to the manager on the configured channel (WhatsApp or Telegram). */
async function sendToManager(text, { telegramButtons, ref } = {}) {
  if (config.managerChannel === 'telegram') {
    return sendTelegram(text, telegramButtons, ref);
  }
  const managers = db.prepare("SELECT phone FROM managers WHERE phone IS NOT NULL AND phone != ''").all();
  const phones = new Set(managers.map((m) => m.phone));
  if (config.admin.phone) phones.add(config.admin.phone);
  if (phones.size === 0) {
    console.log(`[manager:log] (no MANAGER_PHONE set)\n${text}\n`);
    record('whatsapp', 'manager', text, 'logged', 'no manager phone configured', ref);
    return { ok: true, logged: true };
  }
  const results = [];
  for (const p of phones) results.push(await sendWhatsApp(p, text, ref));
  return results.find((r) => !r.ok) || { ok: true };
}

module.exports = { normalizePhone, sendWhatsApp, sendTelegram, sendToManager, telegramApi, record };

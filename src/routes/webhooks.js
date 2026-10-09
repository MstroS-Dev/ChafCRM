/**
 * Incoming integrations:
 *   POST /webhooks/lead?key=...       generic JSON/form lead (Make, Zapier, Instagram/Facebook lead ads, website)
 *   POST /webhooks/greenapi?key=...   Green API incoming WhatsApp messages
 *   POST /webhooks/twilio?key=...     Twilio incoming WhatsApp/SMS messages
 *   POST /webhooks/telegram           Telegram bot buttons (manager approve / reject)
 */
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { safeEqual } = require('../auth');
const { normalizePhone, sendWhatsApp, telegramApi, record } = require('../messaging');
const leads = require('../services/leads');
const production = require('../services/production');

const r = express.Router();

function checkKey(req, res, next) {
  const key = req.query.key || req.get('x-webhook-key') || '';
  if (!config.webhookKey) {
    return res.status(503).json({ ok: false, error: 'WEBHOOK_KEY is not configured on the server' });
  }
  if (!safeEqual(key, config.webhookKey)) return res.status(401).json({ ok: false, error: 'bad key' });
  next();
}

// ───────────── Generic lead intake
r.post('/lead', checkKey, async (req, res) => {
  try {
    const b = req.body || {};
    const id = await leads.createLead({
      name: b.name || b.full_name || [b.first_name, b.last_name].filter(Boolean).join(' '),
      phone: b.phone || b.phone_number || b.tel,
      email: b.email,
      requested_date: b.requested_date || b.date || b.event_date,
      event_type: b.event_type || b.type,
      location: b.location || b.city || b.venue,
      notes: b.notes || b.message || b.comments,
      source: b.source || 'webhook',
    });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ───────────── Shared handling of an incoming WhatsApp text
// (\b doesn't work with Hebrew letters, so the end of a keyword is matched explicitly)
const END = '(?=\\s|$|[.!,?])';
const DECLINE = new RegExp(`^(לא\\s*(מאשרת|מאשר|יכולה|יכול|זמינה|זמין)?|2|❌|no)${END}`, 'i');
const CONFIRM = new RegExp(`^(מאשרת|מאשרים|מאשר|כן|אישור|סגור|בטח|1|✅|👍|yes|ok|אוקיי)${END}`, 'i');

function findCrewByPhone(phone) {
  const tail = normalizePhone(phone).slice(-9);
  if (!tail) return null;
  return db.prepare("SELECT * FROM crew WHERE active = 1 AND phone IS NOT NULL AND phone != ''").all()
    .find((c) => normalizePhone(c.phone).slice(-9) === tail) || null;
}

function isManagerPhone(phone) {
  const tail = normalizePhone(phone).slice(-9);
  const phones = db.prepare("SELECT phone FROM managers WHERE phone IS NOT NULL AND phone != ''").all().map((m) => m.phone);
  if (config.admin.phone) phones.push(config.admin.phone);
  return phones.some((p) => normalizePhone(p).slice(-9) === tail);
}

async function handleIncomingText({ phone, name, text, channel }) {
  record(channel, normalizePhone(phone), text, 'received', null, name ? `from:${name}` : null);
  if (!phone || isManagerPhone(phone)) return 'ignored';
  const clean = String(text || '').trim();

  const crew = findCrewByPhone(phone);
  if (crew) {
    const answer = DECLINE.test(clean) ? 'declined' : CONFIRM.test(clean) ? 'confirmed' : null;
    if (!answer) return 'crew-chat';
    // Apply to the nearest upcoming assignment still waiting for an answer (or the nearest one at all)
    const a = db.prepare(`SELECT a.id, e.name FROM assignments a JOIN events e ON e.id = a.event_id
      WHERE a.crew_id = ? AND e.date >= date('now') AND e.status != 'cancelled'
      ORDER BY (a.confirm_status = 'pending') DESC, e.date ASC LIMIT 1`).get(crew.id);
    if (!a) return 'crew-no-assignment';
    await production.respond(a.id, answer);
    await sendWhatsApp(crew.phone, answer === 'confirmed'
      ? `תודה ${crew.name.split(' ')[0]}! ההגעה ל"${a.name}" אושרה ✅`
      : `תודה על העדכון, סימנו שאינך זמין/ה ל"${a.name}".`, `ack:${a.id}`);
    return `crew-${answer}`;
  }

  if (!config.createLeadsFromWhatsApp) return 'ignored';
  if (leads.findRecentByPhone(phone)) return 'known-contact';
  await leads.createLead({ name: name || null, phone: `+${normalizePhone(phone)}`, notes: clean, source: 'whatsapp' });
  return 'lead-created';
}

// ───────────── Green API
r.post('/greenapi', checkKey, async (req, res) => {
  res.json({ ok: true }); // answer fast; Green API retries on slow responses
  try {
    const b = req.body || {};
    if (b.typeWebhook !== 'incomingMessageReceived') return;
    const chatId = b.senderData && b.senderData.chatId;
    if (!chatId || !chatId.endsWith('@c.us')) return; // ignore groups
    const md = b.messageData || {};
    const text = (md.textMessageData && md.textMessageData.textMessage)
      || (md.extendedTextMessageData && md.extendedTextMessageData.text)
      || (md.buttonsResponseMessage && md.buttonsResponseMessage.selectedButtonText)
      || '';
    await handleIncomingText({
      phone: chatId.replace('@c.us', ''),
      name: b.senderData.senderName || b.senderData.chatName,
      text,
      channel: 'whatsapp',
    });
  } catch (e) {
    console.error('[greenapi webhook]', e);
  }
});

// ───────────── Twilio
r.post('/twilio', checkKey, async (req, res) => {
  try {
    const b = req.body || {};
    const from = String(b.From || '').replace('whatsapp:', '');
    await handleIncomingText({ phone: from, name: b.ProfileName, text: b.Body, channel: from === b.From ? 'sms' : 'whatsapp' });
  } catch (e) {
    console.error('[twilio webhook]', e);
  }
  res.type('text/xml').send('<Response></Response>');
});

// ───────────── Telegram (manager buttons)
r.post('/telegram', async (req, res) => {
  const secret = req.get('x-telegram-bot-api-secret-token') || '';
  if (!config.webhookKey || !safeEqual(secret, config.webhookKey)) return res.status(401).end();
  res.json({ ok: true });
  try {
    const cq = req.body && req.body.callback_query;
    if (!cq) return;
    if (String(cq.message && cq.message.chat && cq.message.chat.id) !== String(config.telegram.chatId)) return;
    const [scope, action, idStr] = String(cq.data || '').split(':');
    if (scope !== 'lead') return;
    const id = Number(idStr);
    let note;
    if (action === 'approve') {
      const out = await leads.approveLead(id);
      note = out ? `✅ נוצר כרטיס לקוח\n${config.baseUrl}/admin/clients/${out.clientId}` : 'הליד לא נמצא';
    } else if (action === 'reject') {
      note = leads.rejectLead(id) ? '🚫 סומן כלא רלוונטי' : 'הליד לא נמצא';
    }
    await telegramApi('answerCallbackQuery', { callback_query_id: cq.id, text: note ? note.split('\n')[0] : '' });
    if (note && cq.message) {
      await telegramApi('editMessageText', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `${cq.message.text}\n\n${note}`,
        disable_web_page_preview: true,
      });
    }
  } catch (e) {
    console.error('[telegram webhook]', e);
  }
});

module.exports = r;
module.exports.handleIncomingText = handleIncomingText;

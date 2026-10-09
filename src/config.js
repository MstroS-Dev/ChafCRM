const path = require('path');
const crypto = require('crypto');

const env = process.env;

function bool(v, d = false) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'chafcrm.db'),
  secret: env.APP_SECRET || '',
  secureCookies: bool(env.SECURE_COOKIES, (env.BASE_URL || '').startsWith('https://')),

  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'מנהל',
    phone: env.MANAGER_PHONE || '',
  },

  // Business/brand shown in messages and UI
  brand: env.BRAND_NAME || 'ChafCRM',

  // WhatsApp / SMS provider: "log" (default, writes to log only), "greenapi", "twilio"
  whatsapp: {
    provider: (env.WHATSAPP_PROVIDER || 'log').toLowerCase(),
    greenApi: {
      url: (env.GREEN_API_URL || 'https://api.green-api.com').replace(/\/$/, ''),
      idInstance: env.GREEN_API_ID_INSTANCE || '',
      token: env.GREEN_API_TOKEN || '',
    },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM || '', // e.g. whatsapp:+14155238886 or +1555... for SMS
    },
    countryCode: env.DEFAULT_COUNTRY_CODE || '972',
  },

  // Manager alerts channel: "whatsapp" (default) or "telegram"
  managerChannel: (env.MANAGER_CHANNEL || 'whatsapp').toLowerCase(),
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
  },

  // Shared secret for incoming webhooks (lead webhook, Green API, Twilio, Telegram)
  webhookKey: env.WEBHOOK_KEY || '',

  // Automations
  autoReplyToClient: bool(env.AUTO_REPLY_TO_CLIENT, true),
  createLeadsFromWhatsApp: bool(env.CREATE_LEADS_FROM_WHATSAPP, true),
  reminderHoursBefore: Number(env.REMINDER_HOURS_BEFORE || 24),
  unconfirmedAlertHours: Number(env.UNCONFIRMED_ALERT_HOURS || 48),
  schedulerCron: env.SCHEDULER_CRON || '*/5 * * * *',
};

if (!config.secret) {
  if (env.NODE_ENV === 'production') {
    throw new Error('APP_SECRET must be set in production (any long random string).');
  }
  config.secret = 'dev-secret-' + crypto.createHash('sha256').update(config.dbPath).digest('hex');
}

module.exports = config;

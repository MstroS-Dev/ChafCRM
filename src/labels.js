// Hebrew labels for every enum in the system, used by views and messages.
module.exports = {
  eventTypes: ['חתונה', 'בר מצווה', 'בת מצווה', 'הופעה פתוחה', 'אירוע חברה', 'חינה', 'ברית', 'אחר'],

  eventStatus: {
    planning: 'בתכנון',
    approved: 'אושר',
    done: 'בוצע',
    cancelled: 'בוטל',
  },

  crewKind: {
    musician: 'נגן',
    tech: 'צוות טכני',
    supplier: 'ספק חיצוני',
  },

  instruments: ['שירה', 'תופים', 'בס', 'גיטרה', 'קלידים', 'כלי נשיפה', 'כלי הקשה', 'כינור', 'טכנאי סאונד', 'הגברה', 'תאורה', 'DJ'],

  confirmStatus: {
    pending: 'טרם אושר',
    confirmed: 'אושר',
    declined: 'לא זמין',
  },

  paymentStatus: {
    unpaid: 'טרם שולם',
    deposit: 'מקדמה',
    paid: 'שולם במלואו',
  },

  audience: {
    all: 'כולם',
    musicians: 'נגנים וצוות',
    suppliers: 'ספקים',
  },

  leadStatus: {
    new: 'ממתין לאישור',
    approved: 'אושר → לקוח',
    rejected: 'לא רלוונטי',
  },

  leadSource: {
    form: 'טופס באתר',
    whatsapp: 'WhatsApp',
    instagram: 'אינסטגרם',
    facebook: 'פייסבוק',
    manual: 'הוזן ידנית',
    webhook: 'חיבור חיצוני',
    phone: 'טלפון',
  },

  clientStatus: {
    new_lead: 'ליד חדש',
    quote_sent: 'נשלחה הצעת מחיר',
    negotiation: 'במשא ומתן',
    closed: 'סגור (הפך לאירוע)',
    lost: 'אבוד',
  },

  interactionKind: {
    note: 'הערה',
    call: 'שיחה',
    quote: 'הצעת מחיר',
    whatsapp: 'WhatsApp',
    meeting: 'פגישה',
    system: 'מערכת',
  },

  defaultTimeline: [
    { label: 'הגעה', audience: 'all' },
    { label: 'סאונד-צ׳ק', audience: 'all' },
    { label: 'קבלת פנים', audience: 'all' },
    { label: 'חופה / עלייה לבמה', audience: 'all' },
    { label: 'סט 1', audience: 'all' },
    { label: 'סט 2', audience: 'all' },
  ],
};

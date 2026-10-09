process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

const path = require('path');
const express = require('express');
const config = require('./config');
require('./db');
const labels = require('./labels');
const util = require('./util');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  // /apply may be embedded on the business website; everything else may not be framed
  if (!req.path.startsWith('/apply')) res.set('X-Frame-Options', 'DENY');
  res.locals.L = labels;
  res.locals.u = util;
  res.locals.brand = config.brand;
  res.locals.msg = typeof req.query.msg === 'string' ? req.query.msg : null;
  res.locals.path = req.path;
  res.locals.manager = null;
  res.locals.crew = null;
  next();
});

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));
app.use('/c', require('./routes/crew'));
app.use('/webhooks', require('./routes/webhooks'));

app.use((req, res) => res.status(404).render('error', { title: 'הדף לא נמצא', message: '' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'שגיאה', message: 'משהו השתבש. נסה שוב.' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`[${config.brand}] listening on :${config.port} — ${config.baseUrl}`);
    console.log(`[messaging] WhatsApp provider: ${config.whatsapp.provider}, manager channel: ${config.managerChannel}`);
    require('./scheduler').start();
  });
}

module.exports = app;

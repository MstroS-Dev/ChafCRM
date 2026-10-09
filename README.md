# ChafCRM

Two connected systems for a live-music / events business, in Hebrew (RTL) and built mobile-first:

1. **Production system.** Events, run sheet, line-up, crew and suppliers, supplier payments, and WhatsApp confirmations and reminders.
2. **Leads and CRM.** Leads arrive from the website, WhatsApp, Instagram or Facebook. The manager approves or rejects each one from their phone. Approved leads become client cards with a sales pipeline, and a closed deal turns into an event in system 1.

Stack: Node.js 22, Express, SQLite (single file in `./data`), EJS server-rendered pages, Docker.

## What's included

| Spec item | Where |
|---|---|
| Event card: type, date, venue, arrival / soundcheck / reception times, number of musicians, status | `/admin/events` |
| Line-up: musicians assigned to roles, plus a warning when someone is already booked that day | Event page → "הרכב וספקים" |
| Detailed run sheet. Each item can be shown to everyone, to musicians only, or to suppliers only | Event page → "לו״ז" |
| Crew & supplier database: role, phone, email, availability, agreed price, payment status (unpaid / deposit / paid) | `/admin/crew`, `/admin/payments` |
| **Access control.** The manager has full access with a password login. Musicians get a personal no-password link and see only the run sheet, location and times, with no money. Suppliers also see technical requirements and supplier-only run-sheet items. | `/c/<personal-token>` |
| Booking message: WhatsApp with event details and a confirm / decline link. Crew can also just reply "מאשר" or "לא מאשר" | Automatic when assigning |
| Reminder 24h before soundcheck to all crew, with a Waze link, the run sheet and highlights | Scheduler, every 5 min |
| Manager alert when someone hasn't confirmed 48h before the event | Scheduler |
| Manager alert when someone declines | Automatic |
| Lead intake from: website form, incoming WhatsApp, Instagram/Facebook (via Make/Zapier webhook), manual entry | `/apply`, `/webhooks/*`, `/admin/leads/new` |
| Manager approval message ("📩 ליד חדש נכנס!") with **צור כרטיס לקוח / סמן כלא רלוונטי**. On WhatsApp it's a one-tap link; on Telegram it's inline buttons | `src/services/leads.js` |
| Client card: status pipeline (new lead → quote sent → negotiation → closed → lost), contact history, quotes, optional auto-reply to the client | `/admin/clients/:id` |
| Closed deal: "צור אירוע במערכת ההפקה" creates the event with date, venue and price taken from the last quote | Client card |
| Message log of everything sent or received, including failures | `/admin/messages` |

## Deploy on EC2

**Requirements:** any small instance (t3.small or t4g.small is plenty) running Amazon Linux 2023 or Ubuntu. Open inbound TCP **3000** in the security group, or **80 and 443** if you use a domain.

SSH into the server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/MstroS-Dev/ChafCRM/main/scripts/ec2-setup.sh | bash
```

The script:
- installs Docker
- clones the repo to `~/ChafCRM`
- creates `.env` with random secrets and a manager password, which it prints
- starts the app

Open `http://<server-ip>:3000` and log in as `admin` with the printed password.

Then edit `~/ChafCRM/.env`:
- `MANAGER_PHONE`
- `BRAND_NAME`
- the WhatsApp keys

Apply the changes with `docker compose up -d`.

### Server that already runs nginx (other websites)
The app listens only on `127.0.0.1:3000` and nginx forwards a subdomain to it. With [sslip.io](https://sslip.io), `crm.<ip>.sslip.io` works without any DNS setup:

```bash
D=crm.16.170.108.223.sslip.io   # your subdomain
sed -i "s|^BASE_URL=.*|BASE_URL=https://$D|" .env
sudo docker compose up -d --build
sudo sed "s/CRM_DOMAIN/$D/" deploy/nginx-chafcrm.conf | sudo tee /etc/nginx/sites-available/chafcrm >/dev/null
sudo ln -sf /etc/nginx/sites-available/chafcrm /etc/nginx/sites-enabled/chafcrm
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d $D --redirect
```

### HTTPS with a domain (no other web server) (recommended — Telegram needs it, and links look better)
1. Point a DNS A-record, e.g. `crm.example.com`, at the server's IP.
2. In `.env`, set `DOMAIN=crm.example.com` and `BASE_URL=https://crm.example.com`.
3. Run `docker compose --profile https up -d`. Caddy gets the certificate automatically.

### Auto-deploy on every push to `main`
Add these repository secrets in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `EC2_HOST` | the server's public IP or domain |
| `EC2_USER` | `ec2-user` (Amazon Linux) or `ubuntu` |
| `EC2_SSH_KEY` | the contents of the `.pem` key |

Until they're set, the workflow only runs the tests.

## Connecting WhatsApp

Set `WHATSAPP_PROVIDER` in `.env`. With the default `log`, nothing is sent and messages only appear in the in-app log, which is useful for trying things out.

**Green API** (simplest for Israeli numbers):
1. Create an instance at green-api.com and scan the QR code with the business WhatsApp.
2. In `.env`, set:
   ```
   WHATSAPP_PROVIDER=greenapi
   GREEN_API_ID_INSTANCE=...
   GREEN_API_TOKEN=...
   ```
3. In the instance settings, set the webhook URL to `https://<your-domain>/webhooks/greenapi?key=<WEBHOOK_KEY>` and enable *incoming messages*.

This gives you incoming WhatsApp leads and crew confirmations by text reply.

**Twilio:** set the following in `.env`:
- `WHATSAPP_PROVIDER=twilio`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM=whatsapp:+...`

The incoming webhook is `https://<domain>/webhooks/twilio?key=<WEBHOOK_KEY>`.

**Manager alerts on Telegram instead of WhatsApp** (optional):
1. Create a bot with @BotFather.
2. In `.env`, set:
   ```
   MANAGER_CHANNEL=telegram
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=<your chat id>
   ```
3. Register the webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/webhooks/telegram&secret_token=<WEBHOOK_KEY>"
   ```

## Lead sources

| Source | How to connect it |
|---|---|
| **Website** | Link to `https://<domain>/apply`, or embed it: `<iframe src="https://<domain>/apply?embed=1" style="width:100%;height:720px;border:0"></iframe>` |
| **Instagram / Facebook** (lead ads, DMs via Make/Zapier) | `POST https://<domain>/webhooks/lead?key=<WEBHOOK_KEY>` with JSON. Accepted fields: `name` or `full_name`, `phone`, `email`, `requested_date` (`DD/MM/YYYY` or `YYYY-MM-DD`), `event_type`, `location`, `notes`, `source` (`instagram`, `facebook`, …) |
| **WhatsApp** | Any first message from an unknown number becomes a lead, once the Green API or Twilio webhook is set. Contacts seen in the last 30 days aren't duplicated. |

## Local development

```bash
npm install
ADMIN_PASSWORD=dev npm run dev   # http://localhost:3000
npm test                          # end-to-end smoke test of all flows
```

## Backups

All data is in `~/ChafCRM/data/chafcrm.db`. A daily backup is enough. The command below takes a consistent copy while the app is running, keeping one file per weekday. Add it to the server's crontab:

```
0 3 * * * cd ~/ChafCRM && docker compose exec -T app node -e "require('better-sqlite3')('/app/data/chafcrm.db').backup('/app/data/backup-'+new Date().getDay()+'.db')"
```

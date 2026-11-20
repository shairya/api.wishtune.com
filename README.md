# Wishtune CRM — backend

Node.js + Express + MySQL API behind **https://crm.wishtune.com**. It records
every person who buys from Wishtune (Payhip), signs up on the website or sends
a contact message — one record per person, matched by email — and shows which page and campaign
brought them in. The admin screens live in the separate
`wishtune-crm-frontend` repo.

```
Payhip (paid/refunded) ──► POST /webhooks/payhip   (Payhip signature)
Payhip export (CSV/xlsx) ─► npm run import:payhip    (past orders, one-off)
Sign-up form           ──► POST /api/signup        (wishtune.com origin only)
Netlify contact form   ──► POST /webhooks/contact  (Netlify JWS)
                               │
                services/contactEventService.js   ← the 7 steps / flowchart
                               │
                             MySQL
```

### Database (schema v2)

| Table | Holds |
|---|---|
| `contacts` | one person: names, country, stage, lead source, first page, UTM, consent, unsubscribe, purchase counts (all / paid), **is_internal** (test) |
| `contact_identifiers` | every email and mobile pointing to a contact — **unique per type + value**. Today contacts are matched by email only; moving to "email + mobile" later changes one line (`MATCH_ORDER` in `services/identityService.js`), not the tables |
| `contact_merges` | audit trail for future merges (survivor, merged, who, snapshot) |
| `events` | every incoming event / admin action (incl. rejected + duplicates) |
| `orders`, `order_items` | Payhip orders in their **own currency** (INR main, USD kept): list price, discount, coupon, paid, fees, free yes/no, status, refunds, downloads, webhook or import |
| `products`, `product_prices` | MT-001…MT-015 (format × focus, name as on Payhip) and list price per currency |
| `import_batches` | every import run (dry runs too) with counts |
| `settings` | bot settings, test-contact list |
| `users`, `refresh_tokens`, `bot_outreach` | logins, sessions, bot status |

Product codes: Shower MT-001…005, Party MT-006…010, Sleep MT-011…015, each
in the order Love, Beauty, Health, Wealth, Everything.

The Meta Pixel stays in the browser and sends nothing here. There's no Zapier,
MailerLite, Conversions API or Meta lead form, and V1 sends no email.

---

## 1. How each event is handled (spec steps 1–7)

1. An event arrives: a Payhip sale, a sign-up or a contact message.
2. **Missing or invalid email** → rejected. The reason goes in the event log
   (status `rejected`, shown under *Event log → Rejected*) and no contact is
   created.
3. Email trimmed + lowercased, then looked up: update if it exists, create if not.
4. Details added. **Never overwrites a filled field with an empty one.**
   First page seen, lead source and UTM tags are **first-seen only**.
5. Paid sale → stage **Customer**, purchase count +1; **2+ → Repeat buyer**.
   100%-off orders count for the stage too, but only orders where money was
   paid count as "paid" — that is what the *Meta: paying customers* export uses.
6. Not a sale → stage kept; a Customer never goes back. The one forward move:
   a sign-up lifts a *Contact* to *Subscriber*.
7. Saved and logged with a timestamp. The **Payhip order ID is unique**, so a
   repeated webhook is logged as `duplicate` and never counted twice. Netlify
   retries are de-duplicated by submission ID in the same way.

Stored stages: `contact` · `subscriber` · `customer` · `repeat_buyer`
(Visitor and Buy-clicked exist only in Meta.)

**Campaign:** the first UTM tags seen are kept for good. A buyer with no
earlier sign-up gets campaign `unknown`. A later sign-up does not replace it,
because that ad is not what brought them in; those tags stay on the sign-up's
event.

**Refunds** (Payhip `refunded`): logged and the order is marked refunded.
Stage and purchase count stay as they are (a stage never moves backward); a
full refund takes the order out of the *paid* count.

**Test / team contacts:** anyone matching *Settings → Test contacts* (emails,
domains, coupon codes) — or marked by hand on their page — is kept but left
out of the dashboard, Meta exports and bots, and hidden from the contact list
unless "Test contacts: show" is chosen.

**Unsubscribe:** the *Mark unsubscribed* button on a contact. Unsubscribed
people are left out of the Meta buyers audience and are never contacted by the
bots. They remain in the buyer *exclusion* list, so ads still skip them.

---

## 2. Server setup (Hostinger VPS, next to oxxy)

Ports used: API **5100**, web **3100**, both bound to 127.0.0.1 only.
Check that oxxy doesn't use them: `sudo ss -ltnp | grep -E ':5100|:3100'`.

### 2.1 Database

```sql
-- sudo mysql
CREATE DATABASE wishtune_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wishtune_crm'@'localhost' IDENTIFIED BY '<strong password>';
GRANT ALL PRIVILEGES ON wishtune_crm.* TO 'wishtune_crm'@'localhost';
FLUSH PRIVILEGES;
```

### 2.2 Backend

```bash
cd /var/www
git clone <your wishtune-crm-backend repo> wishtune-crm-backend
cd wishtune-crm-backend
npm install --omit=dev
cp .env.example .env
npm run secrets              # prints JWT_SECRET, JWT_REFRESH_SECRET, COOKIE_SECRET, NETLIFY_JWS_SECRET…
nano .env                    # paste secrets, MySQL password, PAYHIP_API_KEY, NETLIFY_JWS_SECRET
npm run migrate              # creates all tables (safe to re-run)
npm run create-admin         # your admin login (run again for each extra person)
```

### 2.3 Frontend

```bash
cd /var/www
git clone <your wishtune-crm-frontend repo> wishtune-crm-frontend
cd wishtune-crm-frontend
cp .env.example .env.production.local   # NEXT_PUBLIC_API_URL=https://crm.wishtune.com/api/v1
npm install && npm run build
```

### 2.4 Run with pm2

```bash
cd /var/www/wishtune-crm-backend
pm2 start deploy/ecosystem.config.js   # starts wishtune-crm-api + wishtune-crm-web
pm2 save
pm2 logs wishtune-crm-api              # should say "listening on 127.0.0.1:5100"
```

(Edit the two `cwd` paths in `deploy/ecosystem.config.js` if you cloned elsewhere.)

### 2.5 nginx (HTTPS only)

```bash
sudo cp deploy/nginx-crm.wishtune.com.conf /etc/nginx/sites-available/crm.wishtune.com
sudo ln -s /etc/nginx/sites-available/crm.wishtune.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl https://crm.wishtune.com/api/health    # → {"ok":true}
```

If certbot already created a server block for crm.wishtune.com, copy the
three `location` blocks into it instead.

### 2.6 Daily database backup

```bash
chmod +x scripts/backup-db.sh
./scripts/backup-db.sh                      # test once → /var/backups/wishtune-crm/…sql.gz
crontab -e
# add:
30 2 * * * /var/www/wishtune-crm-backend/scripts/backup-db.sh >> /var/log/wishtune-crm-backup.log 2>&1
```

It keeps 14 days of backups (change with `KEEP_DAYS`). Restore with:
`gunzip -c file.sql.gz | mysql -u wishtune_crm -p wishtune_crm`.
For a copy off the server, download the folder now and then, or add an rclone step.

### Updating later

```bash
cd /var/www/wishtune-crm-backend && git pull && npm install --omit=dev && npm run migrate && pm2 restart wishtune-crm-api
cd /var/www/wishtune-crm-frontend && git pull && npm install && npm run build && pm2 restart wishtune-crm-web
```

**This update (schema v2) on your running server:** the commands above are
all it takes. `npm run migrate` runs `002_upgrade_v1_to_v2.js`, which rebuilds
the contact/order tables on the new design and keeps your admin login and
settings. It only does this while the CRM has no contacts or orders (true
today); with data it stops and changes nothing. Then run the import (section 4).

---

## 3. Connecting the three sources

| Source | Where | Value |
|---|---|---|
| Payhip | Settings → Developer → Webhook URL | `https://crm.wishtune.com/webhooks/payhip` |
| Payhip | Settings → Developer → API key | copy into `PAYHIP_API_KEY` |
| Sign-up form | landing pages | paste `website-snippets/signup-form.html`, set `data-page` |
| Offer sign-up form (Netlify, `offer-signup`) | Netlify → Forms → Form notifications → Outgoing webhook, form `offer-signup` | URL `https://crm.wishtune.com/webhooks/signup`, JWS secret = `NETLIFY_JWS_SECRET`. Saved as **Subscriber** with consent (checkbox `consent`), page and UTM (hidden `utm_*` fields, else read from the page URL). `NETLIFY_SIGNUP_FORM_NAMES` lists the forms accepted. |
| Contact form | Netlify → Forms → Form notifications → Outgoing webhook | URL `https://crm.wishtune.com/webhooks/contact`, JWS secret = `NETLIFY_JWS_SECRET` |
| Contact form | wishtune.com/contact | add the optional `mobile` field — see `website-snippets/contact-form-changes.md` |
| Ads (XLNC) | every ad link | `?utm_source=…&utm_medium=…&utm_campaign=…` |

**Settings → Integrations** in the CRM shows the same URLs, whether each key is
set, and when each source last sent something.

**Products:** *Settings → Products* has MT-001…MT-015 filled in with their
Payhip names ("Party Mixtape — Wealth") and INR/USD prices. Sales are matched
by name, or by Payhip product key / ID / permalink if you add them (do this if
you ever rename a product on Payhip). Anything that sold but matched nothing
is listed at the top; editing a product links earlier sales automatically.

**Phone numbers from Payhip:** Payhip's webhook doesn't document a phone or
name field. The CRM reads them if they're there; otherwise buyers' mobiles
come from the forms or are typed in on the contact page.

**Discount code:** Payhip's webhook documents only `used_coupon` (yes/no), not
the code itself. The CRM stores the code if Payhip sends one (`coupon_code` /
`discount_code`); otherwise the order shows "coupon used".

---

## 4. Importing past Payhip orders

Payhip has no API for past orders, so history comes from its export:
**Payhip → Customers → Export** (all dates) → download the CSV. An `.xlsx`
saved from Excel works too.

Copy it to the server, then in the backend folder:

```bash
npm run import:payhip -- ./Customer_List.csv                 # dry run: full report, saves nothing
npm run import:payhip -- ./Customer_List.csv --commit --by Ria
```

- Rows go through the same 7 steps as the webhook, **oldest first**, so stages
  and purchase counts come out right (e.g. 2 orders → Repeat buyer).
- **Payhip Order ID** is the duplicate key shared with the webhook: re-running
  an import, or importing orders the webhook already received, never counts
  an order twice. Importing the exact same file again needs `--force`.
- The whole file is one transaction — if anything unexpected fails, nothing
  is saved. Bad rows (e.g. invalid email) are skipped and listed.
- Saved per order: currency, list price, discount, coupon code and %, amount
  paid and net, Payhip fee, payment type, status (refunds), country/state,
  downloads, date (day only — the export has no time). Unsubscribe / GDPR flags
  are applied to the contact. License keys and addresses are not stored.
- Each run is listed under *Settings → Imports*.

With the export of 10 Nov 2026 (45 orders) the result is 15 contacts: 5 real
buyers (2 paying, 3 with FOUNDERSCIRCLE) and 10 test contacts.

**Going live order:** connect the Payhip webhook first, then export and import
everything up to that moment. Any overlap is skipped by Order ID.

---

## 5. Sandbox: devcrm.wishtune.com + devapi.wishtune.com

A second copy of the CRM for testing, using **the same code** with
`SANDBOX_MODE=true`. Its safety rules are enforced in code (`config/sandbox.js`):

| Risk | What stops it |
|---|---|
| A real customer gets a call / WhatsApp | Bots only reach mobiles in **`config/sandbox.allowlist.json`**: checked when picking contacts **and** again in front of every provider. Missing, empty or broken file → nobody is contacted. Future email/SMS must use `sandbox.canEmail()` / `canContactMobile()`. |
| Real customer data ends up in the sandbox | Any sale / sign-up / message / import whose email isn't an allowlisted tester or a test domain (`example.com`, `example.test`, … plus `testEmailDomains`) is **anonymised on arrival**: email → `sbx-<hash>@example.test`, name / mobile / message / raw payload dropped. Same real email → same anonymous contact, so repeat sales and refunds still line up. |
| Sandbox pointed at the live database | The server refuses to start unless `MYSQL_DB` contains `dev`, `sandbox`, `test` or `staging`. |
| Mixing up the two | Amber "SANDBOX" banner on every page and `[SANDBOX]` in the tab title; separate folders, database, ports (5200/3200), pm2 names and secrets. |

**Allowlist** (`config/sandbox.allowlist.json`, not in git; copy from the example):
```json
{ "users": [ { "name": "Ria", "email": "ria@yourdomain.com", "mobile": "+91 98xxxxxxxx" } ],
  "testEmailDomains": ["example.com"] }
```
Edits are picked up automatically. The list is shown on *Settings → Bots*.

### Set it up (once)
```bash
# DNS: A records devcrm.wishtune.com and devapi.wishtune.com → the VPS IP

# database + users (sandbox user, and a read-only production user for the copy)
sudo mysql -e "CREATE DATABASE wishtune_crm_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'wishtune_dev'@'localhost' IDENTIFIED BY '<pw>';
  GRANT ALL ON wishtune_crm_dev.* TO 'wishtune_dev'@'localhost';
  CREATE USER 'wishtune_ro'@'localhost' IDENTIFIED BY '<pw2>';
  GRANT SELECT ON wishtune_crm.* TO 'wishtune_ro'@'localhost'; FLUSH PRIVILEGES;"

# backend
cd /var/www/html && git clone <backend repo> wishtune-crm-backend-dev && cd wishtune-crm-backend-dev
npm install --omit=dev
cp .env.sandbox.example .env && npm run secrets     # paste NEW secrets + DB passwords into .env
cp config/sandbox.allowlist.example.json config/sandbox.allowlist.json && nano config/sandbox.allowlist.json
npm run migrate && npm run create-admin
npm run sandbox:copy-from-prod -- --yes              # optional: anonymised copy of production

# frontend
cd /var/www/html && git clone <frontend repo> wishtune-crm-frontend-dev && cd wishtune-crm-frontend-dev
cp .env.sandbox.example .env.production.local       # devapi URL + NEXT_PUBLIC_APP_ENV=sandbox
npm install && npm run build

# processes + nginx + certificate
pm2 start /var/www/html/wishtune-crm-backend-dev/deploy/ecosystem.dev.config.js && pm2 save
sudo certbot certonly --nginx -d devcrm.wishtune.com -d devapi.wishtune.com
sudo cp /var/www/html/wishtune-crm-backend-dev/deploy/nginx-dev.wishtune.com.conf /etc/nginx/sites-available/dev.wishtune.com.conf
sudo ln -s /etc/nginx/sites-available/dev.wishtune.com.conf /etc/nginx/sites-enabled/dev.wishtune.com.conf
sudo nginx -t && sudo systemctl reload nginx
curl -s https://devapi.wishtune.com/api/health      # {"ok":true,"sandbox":true}
```

### Testing in the sandbox
- **Do not** add the devapi URL to the real Payhip or Netlify accounts.
  Simulate them instead (signed with the sandbox's own test keys):
  `npm run test:events -- --base https://devapi.wishtune.com --cleanup`
- To test the bots: put your own number in the allowlist, give your test
  contact that mobile on its page, use TeleAgent/Wylto test credentials,
  set `BOTS_ENABLED=true`, `pm2 restart wishtune-dev-api`, switch the channel
  on in *Settings → Bots* and press *Run now*.
- Refresh the data any time with `npm run sandbox:copy-from-prod -- --yes`
  (empties the sandbox first; sandbox admin logins are kept).

---

## 6. Bots (TeleAgent voice, Wylto WhatsApp) — ready, switched off

- `jobs/botOutreachCron.js` runs every 5 min (`BOT_CRON_SCHEDULE`) and does
  **nothing** until `BOTS_ENABLED=true` in `.env`.
- When on, it contacts only people who **have a mobile**, **aren't
  unsubscribed**, **aren't test contacts**, are in a chosen stage, and whose mobile was added at least
  *N* minutes ago. It runs inside business hours (IST), once per person per
  channel, and retries failures up to *max attempts*. Configure this on
  *Settings → Bots*.
- Providers live in `services/bots/providers/` (request shapes ported from
  oxxy). Adding a provider = one file + one line in `services/bots/registry.js`.
- To go live, fill in `TELEAGENT_*` / `WYLTO_*` in `.env` (Wylto needs an
  approved template name, sent with the first name as `{{1}}`), set
  `BOTS_ENABLED=true`, `pm2 restart wishtune-crm-api`, then switch the channel
  on in Settings. Give TeleAgent/Wylto the callback URLs from *Settings →
  Integrations* (`…/webhooks/teleagent?token=<secret>`).

---

## 7. Hand-over test (spec item 12)

**Automated** (signs requests with your keys, checks the database):

```bash
npm run test:events -- --base https://crm.wishtune.com --cleanup
```

It checks all six cases from the spec: sale, sign-up, contact message, second
sale from the same email, invalid email and duplicate order. It also checks
the rules: stages never move back, UTM never overwritten, blanks never
overwrite, retries de-duplicated, bad signatures refused, free orders not
counted as paid, and team domains flagged as test. Test contacts use
`crmtest-…@example.com`; `--cleanup` removes them.

**Real-world** (admin):
1. Payhip sale with a 100%-off coupon → contact appears as Customer, ₹0, "coupon used".
2. Sign-up on a landing page opened with `?utm_source=test&utm_campaign=handover` → Subscriber with page + campaign.
3. Contact form message → Contact (or stays Subscriber if the same email).
4. Second Payhip sale with the same email → Repeat buyer, 2 purchases.
5. Sign-up with `abc@` → rejected and shown under *Event log → Rejected*.
6. In Payhip, resend the first webhook (or wait for a retry) → *duplicate*, count unchanged.

---

## 8. Scripts

| Command | What it does |
|---|---|
| `npm run migrate` | apply new migrations (tracked, safe to re-run). `002` upgrades a server that ran the first version (empty CRM only — it refuses if there is data) |
| `npm run import:payhip -- <file> [--commit]` | import past Payhip orders (section 4) |
| `npm run sandbox:copy-from-prod -- --yes` | sandbox only: fill it with an anonymised copy of production (section 5) |
| `npm run create-admin` | add an admin login (prompted, password hidden) |
| `npm run reset-password` | set a new password + sign that user out everywhere |
| `npm run secrets` | print fresh random secrets for `.env` |
| `npm run test:events` | the hand-over checklist above |
| `scripts/backup-db.sh` | gzip `mysqldump`, keep 14 days |

## 9. API (admin, `Authorization: Bearer`)

`POST /api/v1/auth/login | refresh-token | logout | change-password` ·
`GET /api/v1/dashboard/summary` ·
`GET /api/v1/contacts` (filters: `q stage buyer=paid|free_only|any|non_buyer focus format product currency source country campaign consent unsubscribed has_mobile internal=include|only sort page pageSize`) ·
`GET /api/v1/contacts/export.csv?type=all|paid|buyers|exclusion` (columns `email,stage,products,last_purchase_date`) ·
`GET|PATCH /api/v1/contacts/:id` · `POST /api/v1/contacts/:id/notes` ·
`GET /api/v1/events[?status=rejected]` · `GET /api/v1/events/:id` ·
`GET|POST|PUT|DELETE /api/v1/products` · `GET /api/v1/products/unmapped` ·
`GET|PUT /api/v1/settings/bots` · `POST /api/v1/settings/bots/run-now` · `GET /api/v1/settings/integrations` ·
`GET|PUT /api/v1/settings/internal` · `GET /api/v1/imports`

# LABELDIRECT API

Node server between the static site and Supabase. **Service role key stays here only.**

## Setup

1. Copy env file and fill in keys from [Supabase → Project Settings → API](https://supabase.com/dashboard):

   ```bash
   cp .env.example .env
   ```

   - `SUPABASE_URL` — Project URL  
   - `SUPABASE_ANON_KEY` — anon public (JWT verification)  
   - `SUPABASE_SERVICE_ROLE_KEY` — **secret**, never commit  
   - `ACCOUNTS_ACCESS_TOKEN` — HMAC session secret, and a fallback login token  
   - `BOT_TOKEN` — Telegram bot token (never put this in the static site)  
   - `TELEGRAM_CHANNEL` — channel users must join (`@labelsdirect`)  
   - `TELEGRAM_BOT_USERNAME` — public bot @name for the Generate token link  
   - `REFUND_GROUP_ID` — numeric chat id of the group the bot posts refund requests to (e.g. `-1003715362941`)  
   - `NOWPAYMENTS_API_KEY` — NOWPayments API key (server only)  
   - `IPN_SECRET` — NOWPayments IPN secret for webhook signature verification  
   - `NOWPAYMENTS_API_BASE` — `https://api.nowpayments.io` (or sandbox base URL)  
   - `PUBLIC_SITE_URL` — static site origin (no trailing slash), used for payment success/cancel redirects  
   - `NOWPAYMENTS_IPN_URL` — public HTTPS URL for `POST /api/webhooks/nowpayments` (required for balance credits)  

   Add the bot as an **admin** of the channel so membership checks work.

   Apply **`wallet-deposits.sql`** in Supabase (or via migration) before using wallet routes, and **`refunds.sql`** before using the orders/refunds routes. Add the bot to the refund group so it can post there.

2. Install and run:

   ```bash
   npm install
   npm start
   ```

   API default: `http://localhost:3000`

3. In project root `config.js`, set `LABELDIRECT_API.baseUrl` to that URL (already `http://localhost:3000` for local dev).

4. Serve the static site (Live Server, etc.) from the **WEB** folder. Local `http://localhost` and `http://127.0.0.1` origins are allowed automatically (any port). Add a production origin to `CORS_ORIGIN` in `.env` when you deploy.

5. When `GET http://localhost:3000/api/health` works, run **`supabase-lockdown.sql`** in the Supabase SQL Editor (or apply the migration from Cursor) so browsers cannot hit Postgres directly. Keep the **`lists`** table — named imports still save there. `GET /api/accounts` needs a session from `POST /api/auth/login`.

## Routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/health` | Public |
| POST | `/api/auth/login` | Public (`{ token }` — Telegram-issued token or shared `ACCOUNTS_ACCESS_TOKEN`) |
| GET | `/api/accounts` | Bearer (accounts session from login) |
| GET | `/api/wallet` | Bearer (session must include wallet `sub` from login) |
| POST | `/api/wallet/deposits` | Bearer (`{ amount }` USD, min $10 → `{ invoiceUrl, orderId }`) |
| GET | `/api/orders` | Bearer (one row per purchased account with its refund deadline and case status) |
| POST | `/api/orders/:purchaseId/refunds` | Bearer (`{ login, reasonCode, note?, screenshotUrl }` within 120 minutes of checkout; alerts `REFUND_GROUP_ID`) |
| POST | `/api/webhooks/nowpayments` | NOWPayments IPN (`x-nowpayments-sig` HMAC); credits wallet on `finished` / `confirmed` |
| GET | `/api/admin/lists` | Bearer (id, name, timestamps) |
| GET | `/api/admin/lists/:id` | Bearer (includes `content` and matching `accounts` `{ id, login, price }`) |
| PATCH | `/api/admin/lists/:id` | Bearer (`{ content?, name? }` — remaining lines after row delete, and/or a new list name) |
| DELETE | `/api/admin/lists/:id` | Bearer |
| GET | `/api/admin/accounts` | Bearer (Supabase session) |
| GET | `/api/admin/users` | Bearer (Telegram clients from `access_tokens`) |
| GET | `/api/admin/purchases` | Bearer (purchase history with buyer + accounts) |
| GET | `/api/admin/refunds` | Bearer (refund cases with buyer, account, carrier, reason, screenshot) |
| POST | `/api/admin/refunds/:id/approve` | Bearer (credits the account price back to the buyer and DMs them) |
| POST | `/api/admin/refunds/:id/decline` | Bearer (closes the case and DMs the buyer) |
| POST | `/api/admin/notify` | Bearer (`{ message, telegramUserId? }` — DM via bot; omit id to send to all) |
| PATCH | `/api/admin/accounts/price` | Bearer (`{ ids, price }` — up to 500 account ids) |
| PATCH | `/api/admin/accounts/order` | Bearer (`{ ids }` — full display order, up to 5000) |
| POST | `/api/admin/accounts/delete` | Bearer (`{ ids }` — up to 500 account ids) |
| POST | `/api/admin/paste` | Bearer (JSON `{ rawText, listName, attachListId, price }`) |
| POST | `/api/admin/paste/upload` | Bearer (multipart file + `listName` / `attachListId` / `price`, max 50 MB) |
| DELETE | `/api/admin/accounts/:id` | Bearer |

`POST /api/admin/paste` and `POST /api/admin/paste/upload` save or append a named **`lists`** row and return `202` with `{ accepted: true, list }`. Account parse/insert runs in the background (`process_status`: `processing` → `ready` or `error`). Poll `GET /api/admin/lists` for `process_status` / `process_stats`.

Use `listName` to create a new list, or `attachListId` to append to an existing one. `price` is required and is written to every imported account.

Admin sign-in still uses Supabase Auth in the browser; all data calls send `Authorization: Bearer <access_token>`.

## Deploy on Render (NOWPayments IPN)

1. Push this project to GitHub (monorepo is fine).
2. **New Web Service** → connect the repo → **Root Directory** = `backend`.
3. **Build command:** `npm install` · **Start command:** `npm start` · **Health check path:** `/api/health`.
4. Set environment variables (same as `.env`, especially secrets). After the service URL is live, set:
   - `NOWPAYMENTS_IPN_URL` = `https://<your-service>.onrender.com/api/webhooks/nowpayments`
   - `PUBLIC_SITE_URL` = your live static site origin (no trailing slash)
   - `CORS_ORIGIN` = include that static origin
5. In NOWPayments dashboard, allow the IPN URL (or rely on per-invoice `ipn_callback_url`).
6. Update root `config.js` → `LABELDIRECT_API.baseUrl` = your Render HTTPS URL.
7. Users must **log in again** after deploy so sessions include wallet `sub`.

See [`render.yaml`](render.yaml) for a Blueprint reference.

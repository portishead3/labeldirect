# Backend migration phases

## Phase 1 — Public read via API ✅

- [x] Express app in `backend/`
- [x] `GET /api/accounts` (service role, no card column)
- [x] `accounts.html` + `listings.js` use API (no Supabase on public page)

## Phase 2 — Admin via API ✅

- [x] JWT middleware (`Authorization: Bearer`)
- [x] `GET /api/admin/accounts`, `DELETE /api/admin/accounts/:id`
- [x] `POST /api/admin/paste`, `POST /api/admin/paste/upload` (save/append named `lists` immediately, then import `accounts` in the background; dupes skipped, counted in `process_stats`)
- [x] `GET /api/admin/lists` for the import dialog dropdown and saved-lists table
- [x] `GET /api/admin/lists/:id` for the list detail page
- [x] `PATCH /api/admin/lists/:id` to save remaining lines after row delete
- [x] `DELETE /api/admin/lists/:id` to remove a saved list
- [x] `duplicates` are not stored (`drop-lists-duplicates.sql` still drops that table only if you want it gone)
- [x] `admin.html` uses API for data; Supabase JS **auth only**

## Phase 3 — Lock down Supabase ⏳

- [x] Copy `backend/.env` with **service role** key
- [x] `ws` + Supabase client in `supabaseAdmin.js`
- [ ] Restart API (`npm start`) and confirm `curl http://localhost:3000/api/accounts` returns `[]` or JSON rows (not 500)
- [ ] Run `backend/supabase-lockdown.sql` in Supabase SQL Editor (Cursor MCP was unavailable)

## Phase 4 — Wallet (NOWPayments)

- [x] `wallet-deposits.sql` — `wallets` + `deposits`
- [x] Session `sub` on login, `GET /api/wallet`, `POST /api/wallet/deposits`, IPN webhook
- [x] `payments.html` + `listings.js` checkout redirect

## Phase 5 — Deploy

- [ ] Host API (Render, Railway, etc.)
- [ ] Set production `LABELDIRECT_API.baseUrl` in `config.js`
- [ ] Set `CORS_ORIGIN`, `PUBLIC_SITE_URL`, `NOWPAYMENTS_IPN_URL` on the API host

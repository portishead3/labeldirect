# Deploy LABELDIRECT API to Render

Local git is initialized at the WEB project root. Push to GitHub, then connect Render.

## 1. Push to GitHub

```bash
cd /Users/ian/Documents/WEB
# Create a private repo on GitHub, then:
git remote add origin git@github.com:YOUR_USER/labeldirect.git
git push -u origin main
```

## 2. Create Web Service

- Dashboard → **New Web Service** → select the repo
- **Root Directory:** `backend`
- **Runtime:** Node
- **Build:** `npm install`
- **Start:** `npm start`
- **Health check path:** `/api/health`

## 3. Environment variables

Copy from `backend/.env` (never commit `.env`). After the service gets a URL like `https://labeldirect-api-xxxx.onrender.com`:

| Variable | Example |
|----------|---------|
| `NOWPAYMENTS_IPN_URL` | `https://labeldirect-api-xxxx.onrender.com/api/webhooks/nowpayments` |
| `PUBLIC_SITE_URL` | `https://your-static-site.com` or `http://127.0.0.1:5500` for dev |
| `CORS_ORIGIN` | Same origin(s) as the static site |

Redeploy after setting `NOWPAYMENTS_IPN_URL`.

## 4. Static site

In project root `config.js`:

```js
window.LABELDIRECT_API = { baseUrl: "https://labeldirect-api-xxxx.onrender.com" };
```

## 5. Verify

1. `curl https://.../api/health`
2. Log in again on the site (new sessions include wallet `sub`)
3. Start a $10 deposit → NOWPayments invoice opens
4. After payment, IPN credits balance; navbar balance updates

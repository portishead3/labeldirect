import crypto from "node:crypto";
import { Router } from "express";
import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { fetchAccountRows } from "../lib/withVendor.js";
import { requireAccountsAccess, requireWalletAccess } from "../middleware/auth.js";
import {
  createAccountsSession,
  hashAccessToken,
  isAccountsAccessConfigured,
  tokensEqual,
} from "../lib/accountsAccess.js";
import {
  applyDepositCredit,
  dollarsFromCents,
  ensureWallet,
  getWalletByOwnerKey,
  parseDepositAmount,
  shouldCreditDeposit,
  telegramUserIdForOwner,
} from "../lib/wallet.js";
import { createInvoice, isNowPaymentsConfigured, verifyIpnSignature } from "../lib/nowpayments.js";
import { logUserActivity } from "../lib/activityLog.js";

export const publicRouter = Router();

const PUBLIC_ACCOUNT_COLUMNS =
  "id,login,country,state,outbound,inbound,card_number,expiry,price,account_status,created_at,updated_at,list_id,sort_order,lists(name)";

function publicSiteUrl() {
  const raw = String(process.env.PUBLIC_SITE_URL || "").trim().replace(/\/$/, "");
  return raw;
}

function ipnCallbackUrl() {
  return String(process.env.NOWPAYMENTS_IPN_URL || "").trim();
}

async function loginWithOwnerKey(res, ownerKey, activity) {
  await ensureWallet(ownerKey);
  if (activity) {
    try {
      await logUserActivity(activity);
    } catch (err) {
      console.error("login activity:", err);
    }
  }
  res.json({ accessToken: createAccountsSession({ sub: ownerKey }) });
}

publicRouter.post("/auth/login", async (req, res) => {
  if (!isAccountsAccessConfigured()) {
    res.status(503).json({ error: "Accounts access is not configured." });
    return;
  }
  const token = String((req.body && req.body.token) || "");
  const shared = String(process.env.ACCOUNTS_ACCESS_TOKEN || "");
  if (shared && tokensEqual(token, shared)) {
    try {
      await loginWithOwnerKey(res, "shared");
    } catch (err) {
      console.error("POST /api/auth/login (shared):", err);
      res.status(500).json({ error: err.message || "Could not sign in." });
    }
    return;
  }
  if (!token) {
    res.status(401).json({ error: "That token didn’t work. Check it and try again." });
    return;
  }
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("access_tokens")
      .select("id, telegram_user_id")
      .eq("token_hash", hashAccessToken(token))
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(401).json({ error: "That token didn’t work. Check it and try again." });
      return;
    }
    const ownerKey = String(data.id);
    await loginWithOwnerKey(res, ownerKey, {
      ownerKey,
      telegramUserId: data.telegram_user_id,
      action: "login",
    });
  } catch (err) {
    console.error("POST /api/auth/login:", err);
    res.status(500).json({ error: err.message || "Could not sign in." });
  }
});

publicRouter.get("/accounts", requireAccountsAccess, async (_req, res) => {
  try {
    const client = getSupabaseAdmin();
    const rows = await fetchAccountRows(client, PUBLIC_ACCOUNT_COLUMNS);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/accounts:", err);
    res.status(500).json({ error: err.message || "Could not load accounts." });
  }
});

publicRouter.get("/wallet", requireWalletAccess, async (req, res) => {
  try {
    const wallet = await getWalletByOwnerKey(req.accountsSub);
    if (!wallet) {
      res.json({ balance: 0, currency: "USD" });
      return;
    }
    res.json({ balance: dollarsFromCents(wallet.balance_cents), currency: "USD" });
  } catch (err) {
    console.error("GET /api/wallet:", err);
    res.status(500).json({ error: err.message || "Could not load wallet." });
  }
});

publicRouter.post("/wallet/deposits", requireWalletAccess, async (req, res) => {
  if (!isNowPaymentsConfigured()) {
    res.status(503).json({ error: "Payments are not configured yet." });
    return;
  }
  const siteUrl = publicSiteUrl();
  const ipnUrl = ipnCallbackUrl();
  if (!siteUrl || !ipnUrl) {
    res.status(503).json({
      error: "Set PUBLIC_SITE_URL and NOWPAYMENTS_IPN_URL on the server.",
    });
    return;
  }

  const parsed = parseDepositAmount(req.body && req.body.amount);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const wallet = await ensureWallet(req.accountsSub);
    const telegramUserId = await telegramUserIdForOwner(req.accountsSub);
    const orderId = `ld-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const { data: deposit, error: insertError } = await getSupabaseAdmin()
      .from("deposits")
      .insert({
        wallet_id: wallet.id,
        telegram_user_id: telegramUserId,
        amount_usd: parsed.dollars,
        order_id: orderId,
        payment_status: "pending",
        updated_at: now,
      })
      .select("id, order_id")
      .single();
    if (insertError) throw insertError;

    const { invoiceUrl, invoiceId } = await createInvoice({
      priceAmountUsd: parsed.dollars,
      orderId,
      ipnCallbackUrl: ipnUrl,
      successUrl: `${siteUrl}/payments.html?deposit=success&amount=${encodeURIComponent(String(parsed.dollars))}`,
      cancelUrl: `${siteUrl}/payments.html?deposit=cancel`,
    });

    const { error: updateError } = await getSupabaseAdmin()
      .from("deposits")
      .update({
        nowpayments_invoice_id: invoiceId || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", deposit.id);
    if (updateError) throw updateError;

    try {
      await logUserActivity({
        ownerKey: req.accountsSub,
        telegramUserId,
        action: "deposit_created",
        amountUsd: parsed.dollars,
        details: { deposit_id: deposit.id, order_id: deposit.order_id },
      });
    } catch (err) {
      console.error("deposit_created activity:", err);
    }

    res.json({ invoiceUrl, orderId: deposit.order_id });
  } catch (err) {
    console.error("POST /api/wallet/deposits:", err);
    res.status(err.status === 400 ? 400 : 500).json({
      error: err.message || "Could not start deposit.",
    });
  }
});

publicRouter.post("/webhooks/nowpayments", async (req, res) => {
  const body = req.body;
  const sig = req.headers["x-nowpayments-sig"];
  if (!verifyIpnSignature(body, sig)) {
    res.status(401).json({ error: "Invalid signature." });
    return;
  }

  const orderId = body && (body.order_id || body.orderId);
  const paymentStatus = String(
    (body && (body.payment_status || body.paymentStatus)) || ""
  ).toLowerCase();

  if (!orderId) {
    res.status(400).json({ error: "Missing order_id." });
    return;
  }

  try {
    const client = getSupabaseAdmin();
    const { data: deposit, error: findError } = await client
      .from("deposits")
      .select("id, credited_at")
      .eq("order_id", String(orderId))
      .maybeSingle();
    if (findError) throw findError;
    if (!deposit) {
      res.status(404).json({ error: "Deposit not found." });
      return;
    }

    const now = new Date().toISOString();
    await client
      .from("deposits")
      .update({
        payment_status: paymentStatus || "unknown",
        raw_ipn: body,
        updated_at: now,
      })
      .eq("id", deposit.id);

    if (shouldCreditDeposit(paymentStatus)) {
      await applyDepositCredit(deposit.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/webhooks/nowpayments:", err);
    res.status(500).json({ error: err.message || "Webhook failed." });
  }
});

publicRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

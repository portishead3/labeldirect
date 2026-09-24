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
  centsFromDollars,
  dollarsFromCents,
  ensureWallet,
  getWalletByOwnerKey,
  parseDepositAmount,
  shouldCreditDeposit,
  telegramUserIdForOwner,
} from "../lib/wallet.js";
import { createInvoice, isNowPaymentsConfigured, verifyIpnSignature } from "../lib/nowpayments.js";
import { logUserActivity } from "../lib/activityLog.js";
import {
  sendRefundAlert,
  sendTelegramDocument,
  telegramBotConfigured,
} from "../lib/telegramBot.js";
import {
  isRefundWindowOpen,
  parseRefundRequest,
  refundDeadline,
  refundReasonLabel,
  REFUND_WINDOW_MINUTES,
} from "../lib/refunds.js";

export const publicRouter = Router();

const PUBLIC_ACCOUNT_COLUMNS =
  "id,country,state,outbound,inbound,price,account_status,created_at,updated_at,list_id,sort_order,lists(name)";

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

const ALL_ACCOUNT_COLUMNS =
  "id,login,country,state,outbound,inbound,card_number,expiry,price,account_status,created_at,updated_at,list_id,sort_order,lists(name)";

const MAX_PURCHASE_ACCOUNTS = 3;

function bracket(value) {
  return "[" + String(value == null ? "" : value) + "]";
}

function carrierLabel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "ups" || text.includes("ups")) return "UPS";
  return "FedEx";
}

function resolveCarrier(acct, carriersMap) {
  const fromMap = carriersMap && acct && acct.id != null ? carriersMap[String(acct.id)] : "";
  if (fromMap) return carrierLabel(fromMap);
  if (acct && acct.carrier) return carrierLabel(acct.carrier);
  if (acct && acct.vendor) return carrierLabel(acct.vendor);
  return "FedEx";
}

/** Same pipe format as pasted list lines. */
function formatAccountAsPasteLine(acct) {
  const parts = [
    String((acct && acct.login) || "").trim(),
    "CountryCode=" + bracket(acct && acct.country),
    "StateOrProvinceCode=" + bracket(acct && acct.state),
    "Outbound=" + bracket(acct && acct.outbound != null ? acct.outbound : 0),
    "Inbound=" + bracket(acct && acct.inbound != null ? acct.inbound : 0),
    "CreditCardNumber=" + bracket(acct && acct.card_number),
    "ExpirationDate=" + bracket(acct && acct.expiry),
  ];
  if (acct && acct.account_status) {
    parts.push("AccountStatus=" + bracket(acct.account_status));
  }
  return parts.join(" | ");
}

const REFUND_NOTICE =
  `You have ${REFUND_WINDOW_MINUTES} minutes from now to check these accounts. ` +
  "Open Accounts > Orders to request a refund. After " +
  `${REFUND_WINDOW_MINUTES} minutes the refund option closes.`;

function formatPurchaseTextFile(accounts, carriersMap) {
  const blocks = (accounts || []).map((acct) => {
    const label = resolveCarrier(acct, carriersMap);
    return label + "\n" + formatAccountAsPasteLine(acct);
  });
  return (
    "✅ ORDER SUCCESSFULLY COMPLETED 🎉\n\n" +
    blocks.join("\n\n") +
    "\n\n" +
    REFUND_NOTICE +
    "\n"
  );
}

publicRouter.post("/accounts/purchase", requireWalletAccess, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const uniqueIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    const carriersMap =
      req.body && req.body.carriers && typeof req.body.carriers === "object" ? req.body.carriers : {};

    if (!uniqueIds.length) {
      res.status(400).json({ error: "Select at least one account." });
      return;
    }
    if (uniqueIds.length > MAX_PURCHASE_ACCOUNTS) {
      res.status(400).json({ error: `Select at most ${MAX_PURCHASE_ACCOUNTS} accounts.` });
      return;
    }

    const client = getSupabaseAdmin();

    const { data: accounts, error: acctError } = await client
      .from("accounts")
      .select(ALL_ACCOUNT_COLUMNS)
      .in("id", uniqueIds);
    if (acctError) throw acctError;

    if (!accounts || accounts.length !== uniqueIds.length) {
      res.status(400).json({ error: "One or more accounts are no longer available." });
      return;
    }

    const accountsWithVendor = accounts.map((row) => {
      const vendor = row.lists && row.lists.name ? row.lists.name : "";
      const { lists, ...rest } = row;
      const carrier = resolveCarrier({ ...rest, vendor }, carriersMap);
      return { ...rest, vendor, carrier };
    });

    const totalDollars = accountsWithVendor.reduce((sum, a) => sum + (Number(a.price) || 0), 0);
    const totalCents = centsFromDollars(totalDollars);

    const wallet = await getWalletByOwnerKey(req.accountsSub);
    if (!wallet || wallet.balance_cents < totalCents) {
      res.status(400).json({ error: "Insufficient balance.", required: totalDollars });
      return;
    }

    const newBalanceCents = Number(wallet.balance_cents) - totalCents;
    const now = new Date().toISOString();

    const { error: balanceError } = await client
      .from("wallets")
      .update({ balance_cents: newBalanceCents, updated_at: now })
      .eq("id", wallet.id);
    if (balanceError) throw balanceError;

    const telegramUserId = await telegramUserIdForOwner(req.accountsSub);

    const { error: purchaseError } = await client.from("purchases").insert({
      owner_key: req.accountsSub,
      telegram_user_id: telegramUserId,
      account_data: accountsWithVendor,
      total_usd: totalDollars,
    });
    if (purchaseError) throw purchaseError;

    const deleteIds = accountsWithVendor.map((a) => a.id);
    const { error: deleteError } = await client
      .from("accounts")
      .delete()
      .in("id", deleteIds);
    if (deleteError) throw deleteError;

    try {
      await logUserActivity({
        ownerKey: req.accountsSub,
        telegramUserId,
        action: "account_purchase",
        amountUsd: totalDollars,
        details: {
          account_ids: deleteIds,
          account_count: deleteIds.length,
        },
      });
    } catch (err) {
      console.error("account_purchase activity:", err);
    }

    if (telegramUserId && telegramBotConfigured()) {
      try {
        const fileContent = formatPurchaseTextFile(accountsWithVendor, carriersMap);
        const buf = Buffer.from(fileContent, "utf-8");
        await sendTelegramDocument(
          telegramUserId,
          buf,
          "labeldirect_accounts.txt",
          "✅ ORDER SUCCESSFULLY COMPLETED 🎉 " + REFUND_NOTICE
        );
      } catch (err) {
        console.error("Telegram sendDocument:", err);
      }
    }

    res.json({
      ok: true,
      accounts: accountsWithVendor,
      total: totalDollars,
      balance: dollarsFromCents(newBalanceCents),
    });
  } catch (err) {
    console.error("POST /api/accounts/purchase:", err);
    const msg = err.message || "Could not complete purchase.";
    res.status(500).json({ error: msg });
  }
});

async function fetchOwnerPurchases(client, ownerKey) {
  const { data, error } = await client
    .from("purchases")
    .select("id, account_data, total_usd, created_at")
    .eq("owner_key", ownerKey)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function fetchOwnerRefundCases(client, ownerKey) {
  const { data, error } = await client
    .from("refund_cases")
    .select("id, purchase_id, account_login, reason_code, reason_note, status, created_at")
    .eq("owner_key", ownerKey);
  if (error) throw error;
  return data || [];
}

function refundCaseKey(purchaseId, login) {
  return String(purchaseId) + "::" + String(login || "").trim().toLowerCase();
}

function orderRowsFromPurchases(purchases, refundCases) {
  const casesByKey = Object.create(null);
  (refundCases || []).forEach((row) => {
    casesByKey[refundCaseKey(row.purchase_id, row.account_login)] = row;
  });

  const rows = [];
  (purchases || []).forEach((purchase) => {
    const accounts = Array.isArray(purchase.account_data) ? purchase.account_data : [];
    accounts.forEach((acct) => {
      const login = String((acct && acct.login) || "").trim();
      const existing = casesByKey[refundCaseKey(purchase.id, login)] || null;
      const deadline = refundDeadline(purchase.created_at);
      rows.push({
        purchase_id: purchase.id,
        account_id: acct && acct.id != null ? String(acct.id) : null,
        login,
        card_number: acct && acct.card_number != null ? String(acct.card_number) : "",
        expiry: acct && acct.expiry != null ? String(acct.expiry) : "",
        carrier: resolveCarrier(acct, null),
        vendor: acct && acct.vendor != null ? String(acct.vendor) : "",
        country: acct && acct.country != null ? String(acct.country) : "",
        price: acct && acct.price != null ? Number(acct.price) || 0 : 0,
        purchased_at: purchase.created_at,
        refund_deadline: deadline ? deadline.toISOString() : null,
        refund_open: isRefundWindowOpen(purchase.created_at),
        refund_status: existing ? existing.status : null,
        refund_reason: existing ? refundReasonLabel(existing.reason_code) : null,
      });
    });
  });
  return rows;
}

publicRouter.get("/orders", requireWalletAccess, async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const purchases = await fetchOwnerPurchases(client, req.accountsSub);
    const refundCases = purchases.length
      ? await fetchOwnerRefundCases(client, req.accountsSub)
      : [];
    res.json({
      refundWindowMinutes: REFUND_WINDOW_MINUTES,
      orders: orderRowsFromPurchases(purchases, refundCases),
    });
  } catch (err) {
    console.error("GET /api/orders:", err);
    res.status(500).json({ error: err.message || "Could not load orders." });
  }
});

async function buyerProfile(client, ownerKey) {
  const { data, error } = await client
    .from("access_tokens")
    .select("telegram_user_id, telegram_username, telegram_first_name, telegram_last_name")
    .eq("id", ownerKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function buyerLabel(profile, telegramUserId) {
  const username = String((profile && profile.telegram_username) || "").replace(/^@/, "").trim();
  if (username) return "@" + username;
  const name = [profile && profile.telegram_first_name, profile && profile.telegram_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name) return name;
  return telegramUserId ? "User " + telegramUserId : "A user";
}

function formatRefundAlert(parts) {
  const lines = [
    `${parts.who} just requested refund for the ${parts.carrier.toUpperCase()} account ${parts.login}`,
    "Issue: " + parts.issue,
    "Amount: " + parts.amount,
    "Screenshot: " + (parts.screenshotUrl || "not provided"),
    "Purchased: " + parts.purchasedAt + " · Requested: " + parts.requestedAt,
  ];
  if (parts.telegramUserId) lines.push("Telegram ID: " + parts.telegramUserId);
  return lines.join("\n");
}

function formatUsd(dollars) {
  return "$" + (Math.round((Number(dollars) || 0) * 100) / 100).toFixed(2);
}

function formatAlertTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

publicRouter.post("/orders/:purchaseId/refunds", requireWalletAccess, async (req, res) => {
  try {
    const parsed = parseRefundRequest(req.body);
    const client = getSupabaseAdmin();

    const { data: purchase, error: purchaseError } = await client
      .from("purchases")
      .select("id, owner_key, telegram_user_id, account_data, created_at")
      .eq("id", String(req.params.purchaseId || "").trim())
      .maybeSingle();
    if (purchaseError) throw purchaseError;
    if (!purchase || purchase.owner_key !== req.accountsSub) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    const accounts = Array.isArray(purchase.account_data) ? purchase.account_data : [];
    const account = accounts.find(
      (acct) =>
        String((acct && acct.login) || "").trim().toLowerCase() ===
        parsed.accountLogin.toLowerCase()
    );
    if (!account) {
      res.status(404).json({ error: "That account is not part of this order." });
      return;
    }

    if (!isRefundWindowOpen(purchase.created_at)) {
      res.status(409).json({
        error: `The ${REFUND_WINDOW_MINUTES}-minute refund window for this account has closed.`,
      });
      return;
    }

    const login = String(account.login || "").trim();
    const { data: existing, error: existingError } = await client
      .from("refund_cases")
      .select("id, status")
      .eq("purchase_id", purchase.id)
      .eq("account_login", login)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      res.status(409).json({ error: "A refund case is already open for this account." });
      return;
    }

    const carrier = resolveCarrier(account, null);
    const amountUsd = Number(account.price) || 0;
    const telegramUserId =
      purchase.telegram_user_id != null
        ? purchase.telegram_user_id
        : await telegramUserIdForOwner(req.accountsSub);

    const { data: refundCase, error: insertError } = await client
      .from("refund_cases")
      .insert({
        purchase_id: purchase.id,
        owner_key: req.accountsSub,
        telegram_user_id: telegramUserId,
        account_id: account.id != null ? String(account.id) : null,
        account_login: login,
        carrier,
        amount_usd: amountUsd,
        reason_code: parsed.reasonCode,
        reason_note: parsed.note,
        screenshot_url: parsed.screenshotUrl,
        updated_at: new Date().toISOString(),
      })
      .select("id, status, created_at")
      .single();
    if (insertError) throw insertError;

    try {
      await logUserActivity({
        ownerKey: req.accountsSub,
        telegramUserId,
        action: "refund_requested",
        amountUsd,
        details: {
          refund_case_id: refundCase.id,
          purchase_id: purchase.id,
          account_login: login,
          carrier,
          reason: refundReasonLabel(parsed.reasonCode),
        },
      });
    } catch (err) {
      console.error("refund_requested activity:", err);
    }

    if (telegramBotConfigured()) {
      try {
        const profile = await buyerProfile(client, req.accountsSub);
        await sendRefundAlert(
          formatRefundAlert({
            who: buyerLabel(profile, telegramUserId),
            carrier,
            login,
            issue:
              refundReasonLabel(parsed.reasonCode) +
              (parsed.note ? " — " + parsed.note : ""),
            amount: formatUsd(amountUsd),
            screenshotUrl: parsed.screenshotUrl,
            purchasedAt: formatAlertTime(purchase.created_at),
            requestedAt: formatAlertTime(refundCase.created_at),
            telegramUserId,
          })
        );
      } catch (err) {
        console.error("Telegram refund alert:", err);
      }
    }

    res.json({ ok: true, status: refundCase.status, id: refundCase.id });
  } catch (err) {
    if (err && err.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("POST /api/orders/:purchaseId/refunds:", err);
    res.status(500).json({ error: err.message || "Could not open a refund case." });
  }
});

publicRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

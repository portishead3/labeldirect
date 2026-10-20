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
import {
  newSignInNotice,
  notifyRefundGroup,
  refundRequestedNotice,
  sendTelegramDocument,
  telegramBotConfigured,
  telegramDisplayName,
} from "../lib/telegramBot.js";
import {
  isRefundWindowOpen,
  parseRefundRequest,
  refundDeadline,
  refundReasonLabel,
  REFUND_WINDOW_MINUTES,
} from "../lib/refunds.js";
import { parseLine } from "../lib/parsePaste.js";

export const publicRouter = Router();

const PUBLIC_ACCOUNT_COLUMNS =
  "id,country,state,outbound,inbound,address,billing,price,account_status,created_at,updated_at,list_id,sort_order,lists(name)";

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
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from("access_tokens")
      .select("id, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name")
      .eq("token_hash", hashAccessToken(token))
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(401).json({ error: "That token didn’t work. Check it and try again." });
      return;
    }
    const ownerKey = String(data.id);
    let firstSignIn = false;
    try {
      const { count, error: countError } = await client
        .from("user_activity")
        .select("id", { count: "exact", head: true })
        .eq("owner_key", ownerKey)
        .eq("action", "login");
      if (countError) throw countError;
      firstSignIn = !count;
    } catch (err) {
      console.error("login count:", err);
    }
    await loginWithOwnerKey(res, ownerKey, {
      ownerKey,
      telegramUserId: data.telegram_user_id,
      action: "login",
    });
    if (firstSignIn) {
      await notifyRefundGroup(
        newSignInNotice({
          who: telegramDisplayName(data, data.telegram_user_id),
          telegramUserId: data.telegram_user_id,
        })
      );
    }
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
      successUrl: `${siteUrl}/payments?deposit=success&amount=${encodeURIComponent(String(parsed.dollars))}`,
      cancelUrl: `${siteUrl}/payments?deposit=cancel`,
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

const MAX_PURCHASE_ACCOUNTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  ];
  const address = String((acct && acct.address) || "").trim();
  const billing = String((acct && acct.billing) || "").trim();
  if (address) parts.push("Address=" + bracket(address));
  if (billing) parts.push("Billing=" + bracket(billing));
  parts.push(
    "CreditCardNumber=" + bracket(acct && acct.card_number),
    "ExpirationDate=" + bracket(acct && acct.expiry)
  );
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

    if (!uniqueIds.every((id) => UUID_RE.test(id))) {
      res.status(400).json({ error: "One or more accounts are no longer available." });
      return;
    }

    const client = getSupabaseAdmin();
    const telegramUserId = await telegramUserIdForOwner(req.accountsSub);

    // Balance check, debit, purchase record and account removal happen in ONE
    // database transaction with row locks, so parallel requests cannot spend the
    // same balance twice or buy the same account twice.
    const { data: purchase, error: purchaseError } = await client.rpc("purchase_accounts", {
      p_owner_key: req.accountsSub,
      p_ids: uniqueIds,
      p_telegram_user_id: telegramUserId,
      p_carriers: carriersMap,
    });
    if (purchaseError) {
      const text = String(purchaseError.message || "");
      if (text.includes("insufficient_balance")) {
        res.status(400).json({
          error: "Insufficient balance.",
          required: Number(purchaseError.details) || 0,
        });
        return;
      }
      if (text.includes("accounts_unavailable")) {
        res.status(400).json({ error: "One or more accounts are no longer available." });
        return;
      }
      throw purchaseError;
    }

    const accountsWithVendor = Array.isArray(purchase.account_data) ? purchase.account_data : [];
    const totalDollars = Number(purchase.total_usd) || 0;
    const newBalanceCents = Number(purchase.balance_cents) || 0;
    const deleteIds = accountsWithVendor.map((a) => a.id);

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
    .select(
      "id, purchase_id, account_login, reason_code, reason_note, screenshot_url, status, refund_number, created_at"
    )
    .eq("owner_key", ownerKey);
  if (error) throw error;
  return data || [];
}

function refundCaseKey(purchaseId, login) {
  return String(purchaseId) + "::" + String(login || "").trim().toLowerCase();
}

function textField(acct, key) {
  if (!acct || acct[key] == null) return "";
  return String(acct[key]);
}

function lineForLogin(content, login) {
  const wanted = String(login || "").trim().toLowerCase();
  if (!wanted) return "";
  const lines = String(content || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const head = line.split("|")[0].trim().toLowerCase();
    if (head === wanted) return line;
  }
  return "";
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
        card_number: textField(acct, "card_number"),
        expiry: textField(acct, "expiry"),
        carrier: resolveCarrier(acct, null),
        vendor: textField(acct, "vendor"),
        country: textField(acct, "country"),
        state: textField(acct, "state"),
        outbound: acct && acct.outbound != null ? Number(acct.outbound) || 0 : 0,
        inbound: acct && acct.inbound != null ? Number(acct.inbound) || 0 : 0,
        address: textField(acct, "address"),
        billing: textField(acct, "billing"),
        account_status: textField(acct, "account_status"),
        price: acct && acct.price != null ? Number(acct.price) || 0 : 0,
        purchased_at: purchase.created_at,
        account_created_at: textField(acct, "created_at"),
        account_updated_at: textField(acct, "updated_at"),
        list_id: acct && acct.list_id != null ? String(acct.list_id) : "",
        purchase_total: Number(purchase.total_usd) || 0,
        purchase_count: accounts.length,
        refund_deadline: deadline ? deadline.toISOString() : null,
        refund_open: isRefundWindowOpen(purchase.created_at),
        refund_status: existing ? existing.status : null,
        refund_reason: existing ? refundReasonLabel(existing.reason_code) : null,
        refund_note: existing && existing.reason_note ? String(existing.reason_note) : "",
        refund_screenshot: existing && existing.screenshot_url ? String(existing.screenshot_url) : "",
        refund_number: existing && existing.refund_number != null ? existing.refund_number : null,
      });
    });
  });
  return rows;
}

async function attachAccountDetails(client, rows) {
  const listIds = [];
  const seen = Object.create(null);
  rows.forEach((row) => {
    if (!row.list_id || seen[row.list_id]) return;
    seen[row.list_id] = true;
    listIds.push(row.list_id);
  });

  const listsById = Object.create(null);
  if (listIds.length) {
    const { data, error } = await client.from("lists").select("id, name, content").in("id", listIds);
    if (error) {
      console.error("order list lookup:", error);
    } else {
      (data || []).forEach((list) => {
        listsById[list.id] = list;
      });
    }
  }

  return rows.map((row) => {
    const list = row.list_id ? listsById[row.list_id] : null;
    const source = list ? lineForLogin(list.content, row.login) : "";
    const parsed = source ? parseLine(source) : null;
    const address = row.address || (parsed && parsed.address) || "";
    const billing = row.billing || (parsed && parsed.billing) || "";
    const state = row.state || (parsed && parsed.state) || "";
    const country = row.country || (parsed && parsed.country) || "";
    const vendor = row.vendor || (list && list.name) || "";
    const next = {
      ...row,
      address,
      billing,
      state,
      country,
      vendor,
      data: source || formatAccountAsPasteLine({ ...row, address, billing, state, country }),
    };
    delete next.list_id;
    return next;
  });
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
      orders: await attachAccountDetails(client, orderRowsFromPurchases(purchases, refundCases)),
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
      .select("id, status, created_at, refund_number")
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

    try {
      const profile = await buyerProfile(client, req.accountsSub);
      await notifyRefundGroup(
        refundRequestedNotice({
          refundNumber: refundCase.refund_number,
          who: buyerLabel(profile, telegramUserId),
          telegramUserId,
          carrier,
          login,
          issue: refundReasonLabel(parsed.reasonCode),
          note: parsed.note,
          amount: amountUsd,
          screenshotUrl: parsed.screenshotUrl,
        })
      );
    } catch (err) {
      console.error("Telegram refund alert:", err);
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

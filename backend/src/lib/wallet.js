import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { detailsFromDeposit, fromAddressFromIpn, logUserActivity } from "./activityLog.js";

export const WALLET_MIN_DEPOSIT_USD = 10;

export async function ensureWallet(ownerKey) {
  const key = String(ownerKey || "").trim();
  if (!key) throw new Error("Wallet owner is required.");
  const client = getSupabaseAdmin();
  const { data: existing, error: selectError } = await client
    .from("wallets")
    .select("id, owner_key, balance_cents")
    .eq("owner_key", key)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing;

  const { data: inserted, error: insertError } = await client
    .from("wallets")
    .insert({ owner_key: key })
    .select("id, owner_key, balance_cents")
    .single();
  if (insertError) throw insertError;
  return inserted;
}

export async function getWalletByOwnerKey(ownerKey) {
  const { data, error } = await getSupabaseAdmin()
    .from("wallets")
    .select("id, owner_key, balance_cents")
    .eq("owner_key", String(ownerKey))
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function telegramUserIdForOwner(ownerKey) {
  const key = String(ownerKey || "").trim();
  if (!key || key === "shared") return null;
  const { data, error } = await getSupabaseAdmin()
    .from("access_tokens")
    .select("telegram_user_id")
    .eq("id", key)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.telegram_user_id == null) return null;
  return data.telegram_user_id;
}

export function parseDepositAmount(input) {
  const parsed = parseCreditAmount(input);
  if (!parsed.ok) return parsed;
  if (parsed.dollars < WALLET_MIN_DEPOSIT_USD) {
    return {
      ok: false,
      error: `Minimum deposit is $${WALLET_MIN_DEPOSIT_USD.toFixed(2)}.`,
    };
  }
  return parsed;
}

export function parseCreditAmount(input) {
  const raw = String(input == null ? "" : input).trim().replace(/,/g, "");
  if (!raw) return { ok: false, error: "Enter an amount." };
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: "Use up to two decimal places (e.g. 50 or 50.00)." };
  }
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return { ok: false, error: "Enter a positive amount." };
  }
  if (dollars > 100000) {
    return { ok: false, error: "Amount is too large." };
  }
  return { ok: true, dollars: Math.round(dollars * 100) / 100 };
}

export function dollarsFromCents(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

export function centsFromDollars(dollars) {
  return Math.round(Number(dollars) * 100);
}

const CREDIT_STATUSES = new Set(["finished", "confirmed"]);

export function shouldCreditDeposit(paymentStatus) {
  return CREDIT_STATUSES.has(String(paymentStatus || "").toLowerCase());
}

export async function applyDepositCredit(depositId) {
  const client = getSupabaseAdmin();
  const { data: deposit, error: depError } = await client
    .from("deposits")
    .select("id, wallet_id, amount_usd, credited_at, payment_status, telegram_user_id, order_id, raw_ipn")
    .eq("id", depositId)
    .maybeSingle();
  if (depError) throw depError;
  if (!deposit || deposit.credited_at) return { credited: false };

  if (!shouldCreditDeposit(deposit.payment_status)) {
    return { credited: false };
  }

  const addCents = centsFromDollars(deposit.amount_usd);
  const now = new Date().toISOString();

  const { data: wallet, error: walletError } = await client
    .from("wallets")
    .select("owner_key, balance_cents")
    .eq("id", deposit.wallet_id)
    .single();
  if (walletError) throw walletError;

  const newBalance = Number(wallet.balance_cents) + addCents;

  const { data: marked, error: markError } = await client
    .from("deposits")
    .update({ credited_at: now, updated_at: now })
    .eq("id", depositId)
    .is("credited_at", null)
    .select("id")
    .maybeSingle();
  if (markError) throw markError;
  if (!marked) return { credited: false };

  const { error: balanceError } = await client
    .from("wallets")
    .update({ balance_cents: newBalance, updated_at: now })
    .eq("id", deposit.wallet_id);
  if (balanceError) throw balanceError;

  try {
    await logUserActivity({
      ownerKey: wallet.owner_key,
      telegramUserId: deposit.telegram_user_id,
      action: "funds_added",
      amountUsd: deposit.amount_usd,
      fromAddress: fromAddressFromIpn(deposit.raw_ipn),
      details: detailsFromDeposit(deposit),
      createdAt: now,
    });
  } catch (err) {
    console.error("funds_added activity:", err);
  }

  return { credited: true, addCents };
}

export async function creditWalletManually(ownerKey, dollars) {
  const key = String(ownerKey || "").trim();
  if (!key) throw new Error("User is required.");
  const parsed = parseCreditAmount(dollars);
  if (!parsed.ok) {
    const err = new Error(parsed.error);
    err.status = 400;
    throw err;
  }

  const wallet = await ensureWallet(key);
  const telegramUserId = await telegramUserIdForOwner(key);
  const addCents = centsFromDollars(parsed.dollars);
  const now = new Date().toISOString();
  const newBalance = Number(wallet.balance_cents) + addCents;

  const { error: balanceError } = await getSupabaseAdmin()
    .from("wallets")
    .update({ balance_cents: newBalance, updated_at: now })
    .eq("id", wallet.id);
  if (balanceError) throw balanceError;

  try {
    await logUserActivity({
      ownerKey: key,
      telegramUserId,
      action: "manual_credit",
      amountUsd: parsed.dollars,
      details: { source: "admin" },
      createdAt: now,
    });
  } catch (err) {
    console.error("manual_credit activity:", err);
  }

  return {
    amount: parsed.dollars,
    balance: dollarsFromCents(newBalance),
  };
}

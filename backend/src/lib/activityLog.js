import { getSupabaseAdmin } from "../supabaseAdmin.js";

export function fromAddressFromIpn(rawIpn) {
  if (!rawIpn || typeof rawIpn !== "object") return null;
  const addr = rawIpn.pay_address || rawIpn.payin_address || rawIpn.payAddress;
  const text = String(addr || "").trim();
  return text || null;
}

export function detailsFromDeposit(deposit) {
  const row = deposit || {};
  const ipn = row.raw_ipn && typeof row.raw_ipn === "object" ? row.raw_ipn : {};
  const details = {};
  if (row.id) details.deposit_id = String(row.id);
  if (row.order_id) details.order_id = String(row.order_id);
  const currency = ipn.pay_currency || ipn.payCurrency;
  if (currency) details.pay_currency = String(currency);
  if (ipn.pay_amount != null) details.pay_amount = ipn.pay_amount;
  if (ipn.actually_paid != null) details.actually_paid = ipn.actually_paid;
  return details;
}

export async function logUserActivity(entry) {
  const ownerKey = String((entry && entry.ownerKey) || "").trim();
  const action = String((entry && entry.action) || "").trim();
  if (!ownerKey || !action) return null;

  const row = {
    owner_key: ownerKey,
    telegram_user_id: entry.telegramUserId == null ? null : entry.telegramUserId,
    action,
    amount_usd: entry.amountUsd == null ? null : entry.amountUsd,
    from_address: entry.fromAddress ? String(entry.fromAddress) : null,
    details: entry.details && typeof entry.details === "object" ? entry.details : {},
  };
  if (entry.createdAt) row.created_at = entry.createdAt;

  const { data, error } = await getSupabaseAdmin()
    .from("user_activity")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data;
}

export async function backfillDepositActivity(ownerKey) {
  const key = String(ownerKey || "").trim();
  if (!key) return;

  const client = getSupabaseAdmin();
  const { data: wallet, error: walletError } = await client
    .from("wallets")
    .select("id")
    .eq("owner_key", key)
    .maybeSingle();
  if (walletError) throw walletError;
  if (!wallet) return;

  const { data: deposits, error: depError } = await client
    .from("deposits")
    .select("id, telegram_user_id, amount_usd, order_id, credited_at, raw_ipn, created_at")
    .eq("wallet_id", wallet.id);
  if (depError) throw depError;
  if (!deposits || !deposits.length) return;

  const { data: existing, error: actError } = await client
    .from("user_activity")
    .select("action, details")
    .eq("owner_key", key)
    .in("action", ["deposit_created", "funds_added"]);
  if (actError) throw actError;

  const seen = new Set();
  (existing || []).forEach((row) => {
    const depositId = row.details && row.details.deposit_id;
    if (depositId) seen.add(row.action + ":" + depositId);
  });

  for (const deposit of deposits) {
    const depositId = String(deposit.id);
    if (!seen.has("deposit_created:" + depositId)) {
      await logUserActivity({
        ownerKey: key,
        telegramUserId: deposit.telegram_user_id,
        action: "deposit_created",
        amountUsd: deposit.amount_usd,
        details: detailsFromDeposit({ ...deposit, raw_ipn: null }),
        createdAt: deposit.created_at,
      });
    }
    if (deposit.credited_at && !seen.has("funds_added:" + depositId)) {
      await logUserActivity({
        ownerKey: key,
        telegramUserId: deposit.telegram_user_id,
        action: "funds_added",
        amountUsd: deposit.amount_usd,
        fromAddress: fromAddressFromIpn(deposit.raw_ipn),
        details: detailsFromDeposit(deposit),
        createdAt: deposit.credited_at,
      });
    }
  }
}

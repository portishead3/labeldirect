import crypto from "node:crypto";

function apiKey() {
  return String(process.env.NOWPAYMENTS_API_KEY || "").trim();
}

export function ipnSecret() {
  return String(process.env.IPN_SECRET || process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
}

export function nowPaymentsApiBase() {
  return String(process.env.NOWPAYMENTS_API_BASE || "https://api.nowpayments.io").replace(/\/$/, "");
}

export function isNowPaymentsConfigured() {
  return Boolean(apiKey());
}

function sortedStringify(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

export function verifyIpnSignature(body, headerSig) {
  const secret = ipnSecret();
  if (!secret || !headerSig || !body || typeof body !== "object") return false;
  const expected = crypto.createHmac("sha512", secret).update(sortedStringify(body)).digest("hex");
  const received = String(headerSig).trim().toLowerCase();
  if (expected.length !== received.length) {
    const dummy = Buffer.alloc(32);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
}

export async function createInvoice({
  priceAmountUsd,
  orderId,
  ipnCallbackUrl,
  successUrl,
  cancelUrl,
}) {
  const key = apiKey();
  if (!key) {
    throw new Error("NOWPayments is not configured.");
  }
  const payload = {
    price_amount: Number(priceAmountUsd),
    price_currency: "usd",
    order_id: String(orderId),
    order_description: "LABELDIRECT wallet top-up",
    ipn_callback_url: ipnCallbackUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  const res = await fetch(`${nowPaymentsApiBase()}/v1/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error)) ||
      text ||
      `NOWPayments invoice failed (${res.status}).`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const invoiceUrl = data && (data.invoice_url || data.invoiceUrl);
  const invoiceId = data && (data.id != null ? String(data.id) : "");
  if (!invoiceUrl) {
    throw new Error("NOWPayments did not return an invoice URL.");
  }
  return { invoiceUrl, invoiceId, raw: data };
}

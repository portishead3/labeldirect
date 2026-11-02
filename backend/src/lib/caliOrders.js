import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { caliCredentials } from "./caliWorkflow.js";

// Website orders are posted into the CALI Telegram group. Staff reply to the
// post with the carrier PDFs and the CALI bot reads the post to check them.
const caliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cali");

const CARRIERS = ["FedEx", "UPS"];
const MAX_PASTE_CHARS = 3800; // Telegram messages stop at 4096 characters
const MAX_LBS = 150;
const MAX_KG = 68;
const MAX_PARCELS = 20;
const NO_POSTAL_COUNTRIES = new Set(["Hong Kong", "United Arab Emirates"]);

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_ORDERS = 10;
const recentOrders = new Map();

function oneLine(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function multiLine(value, max) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function readParty(raw, who, requirePhone) {
  const source = raw && typeof raw === "object" ? raw : {};
  const party = {
    country: oneLine(source.country, 60),
    name: oneLine(source.name, 80),
    company: oneLine(source.company, 80),
    street: oneLine(source.street, 120),
    apartment: oneLine(source.apartment, 80),
    city: oneLine(source.city, 60),
    state: oneLine(source.state, 60),
    postalCode: oneLine(source.postalCode, 12),
    email: oneLine(source.email, 120),
    phone: oneLine(source.phone, 30),
  };
  const required = [
    ["name", "name"],
    ["street", "street address"],
    ["city", "city"],
    ["state", "state"],
    ["country", "country"],
  ];
  if (!NO_POSTAL_COUNTRIES.has(party.country)) required.push(["postalCode", "postal code"]);
  if (requirePhone) required.push(["phone", "phone"]);
  for (const [key, label] of required) {
    if (!party[key]) return { error: who + " " + label + " is required." };
  }
  if (party.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(party.email)) {
    return { error: "Enter a valid " + who.toLowerCase() + " email address." };
  }
  return { party };
}

export function parseLabelOrder(body) {
  const input = body && typeof body === "object" ? body : {};
  const carrier = CARRIERS.find((name) => name === input.carrier);
  if (!carrier) return { error: "Choose FedEx or UPS." };

  if (input.mode === "paste") {
    const labelText = multiLine(input.labelText, MAX_PASTE_CHARS + 1);
    if (labelText.length < 10) return { error: "Paste the label details to continue." };
    if (labelText.length > MAX_PASTE_CHARS) {
      return { error: "That is too long. Keep the label details under " + MAX_PASTE_CHARS + " characters." };
    }
    return { order: { carrier, mode: "paste", labelText } };
  }

  if (input.mode !== "form") return { error: "Choose how to enter the details." };

  const sender = readParty(input.sender, "Sender", false);
  if (sender.error) return sender;
  const recipient = readParty(input.recipient, "Recipient", true);
  if (recipient.error) return recipient;

  const parcelsInput = input.parcels && typeof input.parcels === "object" ? input.parcels : {};
  const unit = parcelsInput.unit === "kg" ? "kg" : "lbs";
  const weights = Array.isArray(parcelsInput.weights) ? parcelsInput.weights.slice(0, MAX_PARCELS + 1) : [];
  if (!weights.length || weights.length > MAX_PARCELS) return { error: "Add between 1 and " + MAX_PARCELS + " parcels." };
  const limit = unit === "kg" ? MAX_KG : MAX_LBS;
  const cleanWeights = [];
  for (let i = 0; i < weights.length; i += 1) {
    const n = Number(String(weights[i] == null ? "" : weights[i]).trim().replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) return { error: "Enter a valid weight for parcel " + (i + 1) + "." };
    if (n > limit) return { error: "Max weight per parcel is " + limit + " " + unit + "." };
    cleanWeights.push(String(Math.round(n * 100) / 100));
  }

  return {
    order: {
      carrier,
      mode: "form",
      sender: sender.party,
      recipient: recipient.party,
      parcels: { unit, weights: cleanWeights },
      packageDescription: oneLine(input.packageDescription, 200),
      signatureRequired: input.signatureRequired === true,
      note: multiLine(input.note, 500).replace(/\n+/g, " "),
    },
  };
}

export function newOrderReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return "LD-" + out;
}

function partyLines(party) {
  const lines = ["Name: " + party.name];
  if (party.company) lines.push("Company: " + party.company);
  lines.push("Address: " + party.street);
  if (party.apartment) lines.push("Address: " + party.apartment);
  lines.push("City: " + party.city);
  lines.push("State: " + party.state);
  if (party.postalCode) lines.push("Postal code: " + party.postalCode);
  lines.push("Country: " + party.country);
  if (party.phone) lines.push("Phone: " + party.phone);
  if (party.email) lines.push("Email: " + party.email);
  return lines;
}

// The CALI bot reads this message with its free-form parser, so details are
// written as "Label: value" lines, and the sender block goes last because the
// parser skips everything in it.
export function buildOrderMessage(order, { reference }) {
  const lines = ["Order: " + reference, "Carrier: " + order.carrier, ""];

  if (order.mode === "paste") {
    lines.push(order.labelText);
    return lines.join("\n");
  }

  lines.push(...partyLines(order.recipient));
  const { unit, weights } = order.parcels;
  if (weights.length === 1) {
    lines.push("Weight: " + weights[0] + " " + unit);
  } else {
    weights.forEach((weight, i) => lines.push("Parcel " + (i + 1) + " weight: " + weight + " " + unit));
  }
  if (order.packageDescription) lines.push("Package: " + order.packageDescription);
  if (order.signatureRequired) lines.push("Signature: required on delivery");
  if (order.note) lines.push("Note: " + order.note);
  lines.push("");
  lines.push("Sender:");
  lines.push(...partyLines(order.sender));
  return lines.join("\n");
}

// Who placed the order. Kept in label_orders, never written into the group message.
export async function customerRecord(ownerKey) {
  const record = {
    ownerKey: ownerKey || "",
    telegramUserId: null,
    telegramUsername: null,
    telegramFirstName: null,
    telegramLastName: null,
  };
  if (!ownerKey || ownerKey === "shared") return record;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("access_tokens")
      .select("telegram_user_id, telegram_username, telegram_first_name, telegram_last_name")
      .eq("id", ownerKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) return record;
    record.telegramUserId = data.telegram_user_id ?? null;
    record.telegramUsername = data.telegram_username || null;
    record.telegramFirstName = data.telegram_first_name || null;
    record.telegramLastName = data.telegram_last_name || null;
  } catch (err) {
    console.error("customerRecord:", err.message || err);
  }
  return record;
}

export async function saveLabelOrder({ reference, customer, order, messageId }) {
  const { error } = await getSupabaseAdmin().from("label_orders").insert({
    reference,
    owner_key: customer.ownerKey,
    telegram_user_id: customer.telegramUserId,
    telegram_username: customer.telegramUsername,
    telegram_first_name: customer.telegramFirstName,
    telegram_last_name: customer.telegramLastName,
    carrier: order.carrier,
    mode: order.mode,
    telegram_message_id: messageId ?? null,
    order_json: order,
  });
  if (error) {
    const err = new Error("We could not save your order. Please try again.");
    err.status = 500;
    err.cause = error;
    throw err;
  }
}

export async function deleteLabelOrder(reference) {
  const { error } = await getSupabaseAdmin().from("label_orders").delete().eq("reference", reference);
  if (error) console.error("deleteLabelOrder:", error.message || error);
}

const ORDER_FILES = { label: "label_path", invoice: "invoice_path" };

export function orderDescription(order) {
  if (!order || order.mode === "paste") return "Pasted details";
  const recipient = order.recipient || {};
  const text = [recipient.name, recipient.city].filter(Boolean).join(", ");
  return text || "Label order";
}

export function publicLabelOrder(row) {
  return {
    reference: row.reference,
    carrier: row.carrier,
    status: row.status === "delivered" ? "delivered" : "pending",
    createdAt: row.created_at,
    hasLabel: Boolean(row.label_path),
    hasInvoice: Boolean(row.invoice_path),
    edited: row.edited === true,
    description: orderDescription(row.order_json),
  };
}

export async function listLabelOrders(ownerKey) {
  const { data, error } = await getSupabaseAdmin()
    .from("label_orders")
    .select("reference, carrier, status, created_at, label_path, invoice_path, edited, order_json")
    .eq("owner_key", ownerKey)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []).map(publicLabelOrder);
}

// Only the label and invoice can be read, and only by the account that placed the order.
export async function readLabelOrderFile(ownerKey, reference, file) {
  const column = ORDER_FILES[file];
  if (!column || !/^LD-[A-Z0-9]{6}$/.test(reference)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("label_orders")
    .select("owner_key, label_path, invoice_path")
    .eq("reference", reference)
    .maybeSingle();
  if (error) throw error;
  const objectPath = reference + "/" + file + ".pdf";
  if (!data || data.owner_key !== ownerKey || data[column] !== objectPath) return null;
  const downloaded = await getSupabaseAdmin().storage.from("label-orders").download(objectPath);
  if (downloaded.error || !downloaded.data) return null;
  return {
    buffer: Buffer.from(await downloaded.data.arrayBuffer()),
    filename: reference + "-" + file + ".pdf",
  };
}

export function orderRateLimited(ownerKey) {
  const now = Date.now();
  const recent = (recentOrders.get(ownerKey) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_ORDERS) {
    recentOrders.set(ownerKey, recent);
    return true;
  }
  recent.push(now);
  recentOrders.set(ownerKey, recent);
  return false;
}

export function caliOrdersConfigured() {
  const { token, groupId } = caliCredentials(caliRoot);
  return Boolean(token && groupId);
}

export async function sendOrderToCali(text) {
  const { token, groupId } = caliCredentials(caliRoot);
  if (!token || !groupId) {
    const err = new Error("Ordering is not available right now.");
    err.status = 503;
    throw err;
  }
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: groupId, text, disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    console.error("CALI group sendMessage failed:", (data && data.description) || res.status);
    const err = new Error("We could not send your order. Please try again.");
    err.status = 502;
    throw err;
  }
  return data.result;
}

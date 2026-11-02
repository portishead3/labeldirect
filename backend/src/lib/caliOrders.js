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

// order-pen001: first three letters of the Telegram username, or the first three
// digits of the id when there is no username, then this person's order count.
export function orderPrefix(customer) {
  const letters = String((customer && customer.telegramUsername) || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (letters.length >= 3) return letters.slice(0, 3);
  const digits = String((customer && customer.telegramUserId) || "").replace(/\D/g, "");
  if (digits.length >= 3) return digits.slice(0, 3);
  return (letters + digits + "web").slice(0, 3).padEnd(3, "x");
}

export async function newOrderReference(customer) {
  const prefix = orderPrefix(customer);
  const ownerKey = (customer && customer.ownerKey) || "";
  const { count, error } = await getSupabaseAdmin()
    .from("label_orders")
    .select("id", { count: "exact", head: true })
    .eq("owner_key", ownerKey);
  if (error) throw error;
  let n = (count || 0) + 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reference = "order-" + prefix + String(n).padStart(3, "0");
    const { data, error: existsError } = await getSupabaseAdmin()
      .from("label_orders")
      .select("reference")
      .eq("reference", reference)
      .maybeSingle();
    if (existsError) throw existsError;
    if (!data) return reference;
    n += 1;
  }
  const err = new Error("We could not save your order. Please try again.");
  err.status = 500;
  throw err;
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

export async function saveLabelOrder({ reference, customer, order, messageId, customerMessageId, origin }) {
  const row = {
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
  };
  if (customerMessageId) row.customer_message_id = customerMessageId;
  if (origin) row.origin = origin;
  const { error } = await getSupabaseAdmin().from("label_orders").insert(row);
  if (error) {
    const err = new Error("We could not save your order. Please try again.");
    err.status = 500;
    err.cause = error;
    throw err;
  }
}

export async function customerByTelegram(telegramUserId) {
  const { data, error } = await getSupabaseAdmin()
    .from("access_tokens")
    .select("id, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ownerKey: String(data.id),
    telegramUserId: data.telegram_user_id ?? null,
    telegramUsername: data.telegram_username || null,
    telegramFirstName: data.telegram_first_name || null,
    telegramLastName: data.telegram_last_name || null,
  };
}

// A paste sent in the customer bot. Same checks and group message as the website.
export async function submitBotOrder({ telegramUserId, labelText, detailsMessageId, carrier }) {
  const parsed = parseLabelOrder({ carrier, mode: "paste", labelText });
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.status = 400;
    throw err;
  }
  const customer = await customerByTelegram(telegramUserId);
  if (!customer) {
    const err = new Error("Press Start again, then choose FedEx or UPS.");
    err.status = 400;
    throw err;
  }
  if (orderRateLimited(customer.ownerKey)) {
    const err = new Error("Too many orders in a short time. Wait a few minutes and try again.");
    err.status = 429;
    throw err;
  }
  const reference = await newOrderReference(customer);
  await saveLabelOrder({
    reference,
    customer,
    order: parsed.order,
    messageId: null,
    customerMessageId: detailsMessageId,
    origin: "bot",
  });
  let sent;
  try {
    sent = await sendOrderToCali(buildOrderMessage(parsed.order, { reference }));
  } catch (err) {
    await deleteLabelOrder(reference);
    throw err;
  }
  if (sent && sent.message_id) {
    const { error } = await getSupabaseAdmin()
      .from("label_orders")
      .update({ telegram_message_id: sent.message_id })
      .eq("reference", reference);
    if (error) console.error("label order message id:", error.message || error);
  }
  return { reference, messageId: sent && sent.message_id };
}

export async function editBotOrder({ telegramUserId, detailsMessageId, labelText }) {
  const { data, error } = await getSupabaseAdmin()
    .from("label_orders")
    .select("reference, carrier, telegram_message_id")
    .eq("telegram_user_id", telegramUserId)
    .eq("customer_message_id", detailsMessageId)
    .eq("origin", "bot")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const text = String(labelText || "").trim();
  if (!text || text.startsWith("/")) {
    const err = new Error("Send the label details as a text message.");
    err.status = 400;
    throw err;
  }
  const parsed = parseLabelOrder({ carrier: data.carrier, mode: "paste", labelText: text });
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.status = 400;
    throw err;
  }
  const { error: updateError } = await getSupabaseAdmin()
    .from("label_orders")
    .update({ order_json: parsed.order })
    .eq("reference", data.reference);
  if (updateError) {
    const err = new Error("We could not save your order. Please try again.");
    err.status = 500;
    err.cause = updateError;
    throw err;
  }
  if (!data.telegram_message_id) {
    const err = new Error("We could not update the group message. Please try again.");
    err.status = 502;
    throw err;
  }
  await editOrderInCali(
    data.telegram_message_id,
    buildOrderMessage(parsed.order, { reference: data.reference })
  );
  return data;
}

export async function deleteLabelOrder(reference) {
  const { error } = await getSupabaseAdmin().from("label_orders").delete().eq("reference", reference);
  if (error) console.error("deleteLabelOrder:", error.message || error);
}

const ORDER_FILES = { label: "label_path", invoice: "invoice_path" };
const LABEL_REFERENCE = /^(?:LD-[A-Z0-9]{6}|order-[a-z0-9]{6,})$/;
const LABEL_ORDER_COLUMNS =
  "reference, owner_key, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name," +
  " carrier, status, created_at, label_path, invoice_path, edited, tracking_number, recipient_name, order_json";

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
    trackingNumber: oneLine(row.tracking_number, 80),
    receiverName: receiverNameFromOrder(row),
  };
}

export async function listLabelOrders(ownerKey) {
  const { data, error } = await getSupabaseAdmin()
    .from("label_orders")
    .select("reference, carrier, status, created_at, label_path, invoice_path, edited, tracking_number, recipient_name, order_json")
    .eq("owner_key", ownerKey)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []).map(publicLabelOrder);
}

function pastedReceiverName(labelText) {
  const match = String(labelText || "").match(/(?:^|\n)\s*name\s*:\s*([^\n]+)/i);
  return match ? oneLine(match[1], 200) : "";
}

// Stored name, then the form recipient, then a "Name:" line in pasted details.
export function receiverNameFromOrder(row) {
  const stored = oneLine(row && row.recipient_name, 200);
  if (stored) return stored;
  const order = row && row.order_json && typeof row.order_json === "object" ? row.order_json : {};
  const recipient = order.recipient && typeof order.recipient === "object" ? order.recipient : {};
  const named = oneLine(recipient.name, 200);
  if (named) return named;
  return pastedReceiverName(order.labelText);
}

function adminLabelOrder(row) {
  const order = row.order_json && typeof row.order_json === "object" ? row.order_json : {};
  return {
    reference: row.reference,
    carrier: row.carrier,
    status: row.status === "delivered" ? "delivered" : "pending",
    createdAt: row.created_at,
    trackingNumber: oneLine(row.tracking_number, 80),
    receiverName: receiverNameFromOrder(row),
    hasLabel: Boolean(row.label_path),
    hasInvoice: Boolean(row.invoice_path),
    edited: row.edited === true,
    order,
  };
}

// Every website and bot order, grouped by the customer who placed it.
export async function listAdminLabelOrders() {
  const client = getSupabaseAdmin();
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("label_orders")
      .select(LABEL_ORDER_COLUMNS)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  const groups = [];
  const byOwner = Object.create(null);
  for (let i = 0; i < all.length; i += 1) {
    const row = all[i];
    const key = String(row.owner_key || "");
    let group = byOwner[key];
    if (!group) {
      group = {
        ownerKey: key,
        telegramUserId: row.telegram_user_id ?? null,
        telegramUsername: row.telegram_username || null,
        telegramFirstName: row.telegram_first_name || null,
        telegramLastName: row.telegram_last_name || null,
        orderCount: 0,
        orders: [],
      };
      byOwner[key] = group;
      groups.push(group);
    }
    group.orderCount += 1;
    group.orders.push(adminLabelOrder(row));
  }
  return groups;
}

async function downloadLabelOrderFile(reference, file, allow) {
  const column = ORDER_FILES[file];
  if (!column || !LABEL_REFERENCE.test(reference)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("label_orders")
    .select("owner_key, label_path, invoice_path")
    .eq("reference", reference)
    .maybeSingle();
  if (error) throw error;
  const objectPath = reference + "/" + file + ".pdf";
  if (!data || data[column] !== objectPath || (allow && !allow(data))) return null;
  const downloaded = await getSupabaseAdmin().storage.from("label-orders").download(objectPath);
  if (downloaded.error || !downloaded.data) return null;
  return {
    buffer: Buffer.from(await downloaded.data.arrayBuffer()),
    filename: reference + "-" + file + ".pdf",
  };
}

// Only the label and invoice can be read, and only by the account that placed the order.
export async function readLabelOrderFile(ownerKey, reference, file) {
  return downloadLabelOrderFile(reference, file, (data) => data.owner_key === ownerKey);
}

export async function readAdminLabelOrderFile(reference, file) {
  return downloadLabelOrderFile(reference, file, null);
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

// Tells the customer in their chat with the bot. A missing chat does not fail the order.
export async function notifyCustomerPending(customer, reference) {
  const userId = customer && customer.telegramUserId;
  if (!userId) return null;
  const { token } = caliCredentials(caliRoot);
  if (!token) return null;
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: userId,
      text: reference + " received. Pending.",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    console.error("Customer pending notice:", (data && data.description) || res.status);
    return null;
  }
  return data.result.message_id;
}

export async function sendOrderToCali(text) {
  const { token, groupId } = caliCredentials(caliRoot);
  if (!token || !groupId) {
    console.error("CALI order skipped: token " + Boolean(token) + ", group " + Boolean(groupId));
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

async function notifyGroupEdit(groupId, token, messageId) {
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: groupId,
        text: "Label edited, please check and confirm.",
        reply_to_message_id: messageId,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      console.error("CALI group edit notice:", (data && data.description) || res.status);
    }
  } catch (err) {
    console.error("CALI group edit notice:", err.message || err);
  }
}

export async function editOrderInCali(messageId, text) {
  const { token, groupId } = caliCredentials(caliRoot);
  if (!token || !groupId) {
    const err = new Error("Ordering is not available right now.");
    err.status = 503;
    throw err;
  }
  const res = await fetch("https://api.telegram.org/bot" + token + "/editMessageText", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: groupId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => null);
  const description = (data && data.description) || "";
  if (data && data.ok) {
    await notifyGroupEdit(groupId, token, messageId);
    return data.result;
  }
  if (/message is not modified/i.test(description)) return null;
  console.error("CALI group editMessageText failed:", description || res.status);
  const err = new Error("We could not update the group message. Please try again.");
  err.status = 502;
  throw err;
}

import crypto from "node:crypto";
import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { hashAccessToken } from "./accountsAccess.js";
import { editBotOrder, submitBotOrder } from "./caliOrders.js";

export const TELEGRAM_MESSAGE_MAX = 4096;

function botToken() {
  return String(process.env.BOT_TOKEN || process.env.bot_token || "").trim();
}

export function telegramBotConfigured() {
  return Boolean(botToken());
}

export function telegramChannel() {
  let channel = String(process.env.TELEGRAM_CHANNEL || "@labelsdirect").trim();
  if (!channel) channel = "@labelsdirect";
  if (!channel.startsWith("@") && !/^-?\d+$/.test(channel)) {
    channel = "@" + channel;
  }
  return channel;
}

export function telegramBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
}

export function refundGroupId() {
  return String(process.env.REFUND_GROUP_ID || process.env.refund_group_id || "").trim();
}

export async function sendRefundAlert(text) {
  const chatId = refundGroupId();
  if (!chatId) {
    console.warn("Refund alert skipped: REFUND_GROUP_ID is not set.");
    return null;
  }
  return await sendTelegramMessage(chatId, text, { parseMode: "HTML", disablePreview: true });
}

export async function notifyRefundGroup(text) {
  if (!telegramBotConfigured()) return false;
  try {
    return Boolean(await sendRefundAlert(text));
  } catch (err) {
    console.error("Telegram refund group:", err.message || err);
    return false;
  }
}

export async function sendRefundDocument(fileBuffer, filename, caption) {
  const chatId = refundGroupId();
  if (!chatId) {
    console.warn("Refund alert skipped: REFUND_GROUP_ID is not set.");
    return null;
  }
  return await sendTelegramDocument(chatId, fileBuffer, filename, caption);
}

function apiUrl(method) {
  return "https://api.telegram.org/bot" + botToken() + "/" + method;
}

async function telegramApi(method, body) {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    throw new Error((data && data.description) || method + " failed (" + res.status + ")");
  }
  return data.result;
}

export async function sendTelegramMessage(chatId, text, options) {
  if (!botToken()) {
    throw new Error("Telegram bot token is not set.");
  }
  const message = String(text || "");
  if (!message) {
    throw new Error("Enter a message.");
  }
  if (message.length > TELEGRAM_MESSAGE_MAX) {
    throw new Error("Message is too long. Telegram allows 4096 characters.");
  }
  const opts = options || {};
  const body = {
    chat_id: chatId,
    text: message,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.disablePreview) body.disable_web_page_preview = true;
  return await telegramApi("sendMessage", body);
}

function escapeTelegramHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatNoticeUsd(dollars) {
  const amount = Math.round((Number(dollars) || 0) * 100) / 100;
  return "$" + amount.toFixed(2);
}

function refundLabel(refundNumber) {
  const n = Number(refundNumber);
  if (!Number.isFinite(n) || n < 1) return "Refund";
  return "Refund " + Math.floor(n);
}

export function telegramDisplayName(profile, telegramUserId) {
  const username = String((profile && profile.telegram_username) || "").replace(/^@/, "").trim();
  if (username) return "@" + username;
  const name = [profile && profile.telegram_first_name, profile && profile.telegram_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name) return name;
  return telegramUserId ? "User " + telegramUserId : "A user";
}

function identityLines(who, telegramUserId) {
  const lines = [];
  const name = String(who || "").trim();
  const id = telegramUserId == null ? "" : String(telegramUserId).trim();
  if (name) lines.push(escapeTelegramHtml(name));
  if (id) lines.push("ID " + escapeTelegramHtml(id));
  return lines;
}

export function newSignInNotice(parts) {
  const source = parts || {};
  return ["👤 <b>New sign in</b>", "", ...identityLines(source.who, source.telegramUserId)].join("\n");
}

export function groupBalanceAddedNotice(parts) {
  const source = parts || {};
  return [
    "💰 <b>Balance added</b>",
    "",
    "+" + formatNoticeUsd(source.amount),
    ...identityLines(source.who, source.telegramUserId),
    "Balance · " + formatNoticeUsd(source.balance),
  ].join("\n");
}

export function balanceAddedNotice(amount, balance, refundNumber) {
  const lines = ["💰 <b>Balance added</b>", "", "+" + formatNoticeUsd(amount)];
  const n = Number(refundNumber);
  if (Number.isFinite(n) && n >= 1) lines.push(refundLabel(n));
  lines.push("Balance · " + formatNoticeUsd(balance));
  return lines.join("\n");
}

export function refundRequestedNotice(parts) {
  const source = parts || {};
  const who = String(source.who || "").trim();
  const telegramId = source.telegramUserId == null ? "" : String(source.telegramUserId).trim();
  const carrier = String(source.carrier || "").trim().toUpperCase();
  const login = String(source.login || "").trim();
  const where = [carrier, login].filter(Boolean).join(" · ");
  const issue = String(source.issue || "").trim();
  const note = String(source.note || "").trim();
  const lines = [
    "🧾 <b>Refund requested</b>",
    "",
    escapeTelegramHtml(refundLabel(source.refundNumber)),
  ];
  if (who) lines.push(escapeTelegramHtml(who));
  if (telegramId) lines.push("ID " + escapeTelegramHtml(telegramId));
  if (where) lines.push(escapeTelegramHtml(where));
  if (issue) lines.push(escapeTelegramHtml(issue));
  if (note) lines.push(escapeTelegramHtml(note));
  if (source.amount != null && source.amount !== "") {
    lines.push(typeof source.amount === "number" ? formatNoticeUsd(source.amount) : escapeTelegramHtml(source.amount));
  }
  const shot = String(source.screenshotUrl || "").trim();
  if (shot) lines.push('<a href="' + escapeTelegramHtml(shot) + '">Screenshot</a>');
  return lines.join("\n");
}

export function refundGroupClosedNotice(parts) {
  const source = parts || {};
  const carrier = String(source.carrier || "").trim().toUpperCase();
  const login = String(source.login || "").trim();
  const where = [carrier, login].filter(Boolean).join(" · ");
  const reason = String(source.reason || "").trim();
  const lines = [
    "✅ <b>Refund closed</b>",
    "",
    escapeTelegramHtml(refundLabel(source.refundNumber)),
    ...identityLines(source.who, source.telegramUserId),
  ];
  if (where) lines.push(escapeTelegramHtml(where));
  if (reason) lines.push("refund closed reason: " + escapeTelegramHtml(reason));
  else if (source.messagedOnTelegram) lines.push("Messaged on Telegram");
  const credited = Number(source.refundedUsd);
  if (credited > 0) lines.push("Refunded " + formatNoticeUsd(credited));
  return lines.join("\n");
}

export function refundGroupPaidNotice(parts) {
  const source = parts || {};
  const lines = ["💰 <b>Refund paid</b>", "", "+" + formatNoticeUsd(source.amount)];
  const n = Number(source.refundNumber);
  if (Number.isFinite(n) && n >= 1) lines.push(escapeTelegramHtml(refundLabel(n)));
  lines.push(...identityLines(source.who, source.telegramUserId));
  if (source.balance != null && source.balance !== "") {
    lines.push("Balance · " + formatNoticeUsd(source.balance));
  }
  return lines.join("\n");
}

export function refundClosedReasonNotice(reason) {
  return "refund closed reason: " + escapeTelegramHtml(String(reason || "").trim());
}

export function refundClosedNotice(row) {
  const source = row || {};
  const label = refundLabel(source.refundNumber != null ? source.refundNumber : source.refund_number);
  const carrier = String(source.carrier || "").trim().toUpperCase();
  const login = String(source.accountLogin || source.account_login || "").trim();
  const where = [carrier, login].filter(Boolean).join(" · ");
  const credited = Number(source.refundedUsd != null ? source.refundedUsd : source.refunded_usd);
  const lines = [];
  if (credited > 0) {
    lines.push("💰 <b>Balance added</b>", "", "+" + formatNoticeUsd(credited), "");
  }
  lines.push("✅ <b>Refund closed</b>", "", escapeTelegramHtml(label));
  if (where) lines.push(escapeTelegramHtml(where));
  return lines.join("\n");
}

export async function notifyTelegramUser(chatId, text) {
  if (chatId == null || String(chatId).trim() === "") return false;
  if (!telegramBotConfigured()) return false;
  try {
    await sendTelegramMessage(chatId, text, { parseMode: "HTML", disablePreview: true });
    return true;
  } catch (err) {
    console.error("Telegram user notice:", err.message || err);
    return false;
  }
}

export async function sendTelegramDocument(chatId, fileBuffer, filename, caption) {
  if (!botToken()) {
    throw new Error("Telegram bot token is not set.");
  }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([fileBuffer]), filename || "accounts.txt");
  if (caption) form.append("caption", String(caption));

  const res = await fetch(apiUrl("sendDocument"), {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    throw new Error((data && data.description) || "sendDocument failed (" + res.status + ")");
  }
  return data.result;
}

function isChannelMember(member) {
  const status = member && member.status;
  if (status === "creator" || status === "administrator" || status === "member") return true;
  return status === "restricted" && Boolean(member && member.is_member);
}

function commandParts(text) {
  const match = String(text || "")
    .trim()
    .match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+(\S+))?/);
  if (!match) return { name: "", arg: "" };
  return { name: match[1].toLowerCase(), arg: match[2] || "" };
}

function isPlainStart(text) {
  const command = commandParts(text);
  return command.name === "start" && !command.arg;
}

function isTokenCommand(text) {
  const command = commandParts(text);
  if (command.name === "token") return true;
  return command.name === "start" && (command.arg === "access" || command.arg === "token");
}

function isPrivateChat(chat) {
  return Boolean(chat && chat.type === "private");
}

const awaitingDetails = new Map();

const NEW_ORDER_KEYBOARD = {
  inline_keyboard: [[
    { text: "FedEx", callback_data: "carrier:FedEx" },
    { text: "UPS", callback_data: "carrier:UPS" },
  ]],
};

function carrierFromCallback(data) {
  if (data === "carrier:FedEx") return "FedEx";
  if (data === "carrier:UPS") return "UPS";
  return "";
}

async function answerCallback(callback) {
  try {
    await telegramApi("answerCallbackQuery", { callback_query_id: callback.id });
  } catch (err) {
    console.error("answerCallbackQuery:", err.message || err);
  }
}

async function askForOrder(chatId) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "Do you want to place a new order?",
    reply_markup: NEW_ORDER_KEYBOARD,
  });
}

function telegramProfile(from) {
  const user = from || {};
  const username = String(user.username || "").replace(/^@/, "").trim();
  const firstName = String(user.first_name || "").trim();
  const lastName = String(user.last_name || "").trim();
  return {
    telegram_username: username || null,
    telegram_first_name: firstName || null,
    telegram_last_name: lastName || null,
  };
}

async function requireChannel(message, retry) {
  const userId = message.from && message.from.id;
  const chatId = message.chat && message.chat.id;
  if (!userId || !chatId) return false;
  const channel = telegramChannel();
  let member;
  try {
    member = await telegramApi("getChatMember", { chat_id: channel, user_id: userId });
  } catch (err) {
    console.error("Telegram getChatMember:", err);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Could not check channel membership. Make sure this bot is an admin of the channel, then " + retry + ".",
    });
    return false;
  }
  if (isChannelMember(member)) return true;
  const channelName = channel.replace(/^@/, "");
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "Join the LABELDIRECT channel first, then " + retry + ".",
    reply_markup: {
      inline_keyboard: [[{ text: "Join channel", url: "https://t.me/" + channelName }]],
    },
  });
  return false;
}

async function ensureCustomer(from) {
  const userId = from && from.id;
  if (!userId) return;
  const profile = telegramProfile(from);
  const client = getSupabaseAdmin();
  const { data, error } = await client
    .from("access_tokens")
    .select("id")
    .eq("telegram_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    const { error: updateError } = await client
      .from("access_tokens")
      .update({ ...profile, updated_at: new Date().toISOString() })
      .eq("telegram_user_id", userId);
    if (updateError) throw updateError;
    return;
  }
  const { error: insertError } = await client.from("access_tokens").insert({
    telegram_user_id: userId,
    token_hash: hashAccessToken(crypto.randomBytes(24).toString("base64url")),
    ...profile,
  });
  if (insertError) throw insertError;
}

async function handleStart(message) {
  const userId = message.from && message.from.id;
  const chatId = message.chat && message.chat.id;
  if (!userId || !chatId) return;
  awaitingDetails.delete(userId);
  if (!(await requireChannel(message, "press Start again"))) return;
  try {
    await ensureCustomer(message.from);
  } catch (err) {
    console.error("access_tokens:", err.message || err);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Could not open your account. Try again in a moment.",
    });
    return;
  }
  if (!isPrivateChat(message.chat)) return;
  await askForOrder(chatId);
}

async function handleToken(message) {
  const userId = message.from && message.from.id;
  const chatId = message.chat && message.chat.id;
  if (!userId || !chatId) return;
  if (!isPrivateChat(message.chat)) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Send /token in a private chat.",
    });
    return;
  }
  if (!(await requireChannel(message, "send /token again"))) return;

  const plaintext = crypto.randomBytes(24).toString("base64url");
  const { error } = await getSupabaseAdmin()
    .from("access_tokens")
    .upsert(
      {
        telegram_user_id: userId,
        token_hash: hashAccessToken(plaintext),
        updated_at: new Date().toISOString(),
        ...telegramProfile(message.from),
      },
      { onConflict: "telegram_user_id" }
    );
  if (error) {
    console.error("access_tokens upsert:", error);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Could not create a token. Try again in a moment.",
    });
    return;
  }
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      "Your access token:\n\n`" +
      plaintext +
      "`\n\nPaste it on the Accounts login page. Send /token again if you need a new one — the old token will stop working.",
    parse_mode: "Markdown",
  });
}

async function handleNewOrder(callback, carrier) {
  const message = callback.message;
  const userId = callback.from && callback.from.id;
  const chat = message && message.chat;
  const chatId = chat && chat.id;
  await answerCallback(callback);
  if (!userId || !chatId || !isPrivateChat(chat) || !carrier) return;
  awaitingDetails.set(userId, carrier);
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "Awaiting details.",
  });
}

async function handleOrderEdit(message) {
  const reply = message.reply_to_message;
  const userId = message.from && message.from.id;
  const chatId = message.chat && message.chat.id;
  if (!reply || !userId || !chatId) return false;
  const text = String(message.text || "").trim();
  try {
    const updated = await editBotOrder({
      telegramUserId: userId,
      detailsMessageId: reply.message_id,
      labelText: text,
    });
    if (!updated) return false;
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Details updated and forwarded.",
      reply_to_message_id: message.message_id,
    });
  } catch (err) {
    console.error("Bot order edit:", err.message || err);
    const known = err.status === 400 || err.status === 502 || err.status === 503;
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: known ? err.message : "We could not update your order. Please try again.",
      reply_to_message_id: message.message_id,
    });
  }
  return true;
}

async function handleOrderDetails(message) {
  const userId = message.from && message.from.id;
  const chatId = message.chat && message.chat.id;
  if (!userId || !chatId) return;
  const text = String(message.text || "").trim();
  if (!text || text.startsWith("/")) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Send the label details as a text message.",
    });
    return;
  }
  try {
    await submitBotOrder({
      telegramUserId: userId,
      labelText: text,
      detailsMessageId: message.message_id,
      carrier: awaitingDetails.get(userId),
    });
    awaitingDetails.delete(userId);
  } catch (err) {
    console.error("Bot order:", err.message || err);
    const known = err.status === 400 || err.status === 429 || err.status === 502 || err.status === 503;
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: known ? err.message : "We could not send your order. Please try again.",
    });
    return;
  }
  try {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text:
        "Details received and forwarded for execution. If you need to edit the details, reply to the original message you sent.",
      reply_to_message_id: message.message_id,
    });
  } catch (err) {
    console.error("Order receipt:", err.message || err);
  }
}

export async function startTelegramBot() {
  const token = botToken();
  if (!token) {
    console.warn("Telegram bot skipped: BOT_TOKEN is not set.");
    return;
  }
  // Local checkouts set CALI_POLLING=false. The deployed site does not, so it
  // is the only process that polls. TELEGRAM_POLLING on the host is left alone.
  if (String(process.env.CALI_POLLING || "true").toLowerCase() === "false") {
    console.warn("Telegram bot skipped: this machine is not the deployed bot.");
    return;
  }

  try {
    await telegramApi("deleteWebhook", { drop_pending_updates: true });
  } catch (err) {
    console.warn("Telegram deleteWebhook:", err.message || err);
  }

  const username = telegramBotUsername();
  console.log("Telegram bot polling" + (username ? " @" + username : ""));
  try {
    await telegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "Place a new order" },
        { command: "token", description: "Get your website login token" },
      ],
    });
  } catch (err) {
    console.warn("Telegram setMyCommands:", err.message || err);
  }

  let offset = 0;
  while (true) {
    try {
      const updates = await telegramApi("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          const carrier = carrierFromCallback(update.callback_query.data);
          if (carrier) await handleNewOrder(update.callback_query, carrier);
          else await answerCallback(update.callback_query);
          continue;
        }
        const message = update.message;
        if (!message) continue;
        if (isTokenCommand(message.text)) {
          await handleToken(message);
          continue;
        }
        if (isPlainStart(message.text)) {
          await handleStart(message);
          continue;
        }
        const userId = message.from && message.from.id;
        if (!userId || !isPrivateChat(message.chat)) continue;
        if (message.reply_to_message && (await handleOrderEdit(message))) continue;
        if (!awaitingDetails.has(userId)) continue;
        await handleOrderDetails(message);
      }
    } catch (err) {
      console.error("Telegram getUpdates:", err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

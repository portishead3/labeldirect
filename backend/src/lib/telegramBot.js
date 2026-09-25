import crypto from "node:crypto";
import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { hashAccessToken } from "./accountsAccess.js";

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
  return await sendTelegramMessage(chatId, text);
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

export async function sendTelegramMessage(chatId, text) {
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
  return await telegramApi("sendMessage", {
    chat_id: chatId,
    text: message,
  });
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

function isStartCommand(text) {
  const value = String(text || "").trim();
  return value === "/start" || value.startsWith("/start@") || value.startsWith("/start ");
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

async function handleStart(message) {
  const userId = message.from && message.from.id;
  const chatId = message.chat && message.chat.id;
  if (!userId || !chatId) return;

  const channel = telegramChannel();
  let member;
  try {
    member = await telegramApi("getChatMember", { chat_id: channel, user_id: userId });
  } catch (err) {
    console.error("Telegram getChatMember:", err);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Could not check channel membership. Make sure this bot is an admin of the channel, then press Start again.",
    });
    return;
  }

  if (!isChannelMember(member)) {
    const channelName = channel.replace(/^@/, "");
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Join the LABELDIRECT channel first, then press Start again to get your access token.",
      reply_markup: {
        inline_keyboard: [[{ text: "Join channel", url: "https://t.me/" + channelName }]],
      },
    });
    return;
  }

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
      "`\n\nPaste it on the Accounts login page. Press Start again if you need a new one — the old token will stop working.",
    parse_mode: "Markdown",
  });
}

export async function startTelegramBot() {
  const token = botToken();
  if (!token) {
    console.warn("Telegram bot skipped: BOT_TOKEN is not set.");
    return;
  }
  if (String(process.env.TELEGRAM_POLLING || "true").toLowerCase() === "false") {
    console.warn("Telegram bot skipped: TELEGRAM_POLLING=false.");
    return;
  }

  try {
    await telegramApi("deleteWebhook", { drop_pending_updates: true });
  } catch (err) {
    console.warn("Telegram deleteWebhook:", err.message || err);
  }

  const username = telegramBotUsername();
  console.log("Telegram bot polling" + (username ? " @" + username : ""));

  let offset = 0;
  while (true) {
    try {
      const updates = await telegramApi("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        const message = update.message;
        if (message && isStartCommand(message.text)) {
          await handleStart(message);
        }
      }
    } catch (err) {
      console.error("Telegram getUpdates:", err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

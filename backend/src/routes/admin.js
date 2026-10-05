import { Router } from "express";
import multer from "multer";
import { getSupabaseAdmin } from "../supabaseAdmin.js";
import { requireAdmin } from "../middleware/auth.js";
import { acceptListImport, friendlyListError, parseAccountStatus } from "../lib/parsePaste.js";
import { enqueueListProcess } from "../lib/listJobs.js";
import { fetchAccountRows } from "../lib/withVendor.js";
import {
  sendTelegramMessage,
  telegramBotConfigured,
  TELEGRAM_MESSAGE_MAX,
} from "../lib/telegramBot.js";
import { creditWalletManually, debitWalletManually, dollarsFromCents, getWalletByOwnerKey } from "../lib/wallet.js";
import { backfillDepositActivity } from "../lib/activityLog.js";
import { refundReasonLabel } from "../lib/refunds.js";

const LIST_INDEX_COLUMNS = "id,name,created_at,updated_at,process_status,process_error,process_stats";
const LIST_DETAIL_COLUMNS = LIST_INDEX_COLUMNS + ",content";
const USER_COLUMNS =
  "id,telegram_user_id,telegram_username,telegram_first_name,telegram_last_name,created_at,updated_at";

function parsePrice(value) {
  if (value == null || String(value).trim() === "") {
    throw new Error("Enter a price.");
  }
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("Enter a valid price of 0 or more.");
  }
  return Math.round(n * 100) / 100;
}

function listOptions(body) {
  body = body || {};
  return {
    attachListId: body.attachListId || null,
    listName: body.listName || "",
    price: parsePrice(body.price),
  };
}

function clientIngestStatus(err) {
  const msg = String(err && err.message ? err.message : "");
  if (/Give this list a name|no longer available|already exists|paste a list|no valid lines|Enter a price|valid price|account status|Active or Cash/i.test(msg)) {
    return 400;
  }
  return 500;
}

function inChunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniqueIds(rawIds) {
  const ids = [];
  const seen = Object.create(null);
  const list = Array.isArray(rawIds) ? rawIds : [];
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i] || "").trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    ids.push(id);
  }
  return ids;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNotifyMessage(body) {
  const message = String((body && body.message) || "").trim();
  if (!message) throw new Error("Enter a message.");
  if (message.length > TELEGRAM_MESSAGE_MAX) {
    throw new Error("Message is too long. Telegram allows 4096 characters.");
  }
  return message;
}

function parseTelegramUserId(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid Telegram user.");
  }
  return n;
}

async function fetchAccessTokenUsers(client) {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("access_tokens")
      .select(USER_COLUMNS)
      .order("updated_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function attachWalletBalances(client, users) {
  if (!users.length) return users;
  const ids = users.map((row) => row.id).filter(Boolean);
  const balances = Object.create(null);
  const chunks = inChunks(ids, 200);
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].length) continue;
    const { data, error } = await client
      .from("wallets")
      .select("owner_key, balance_cents")
      .in("owner_key", chunks[i]);
    if (error) throw error;
    (data || []).forEach((wallet) => {
      balances[wallet.owner_key] = dollarsFromCents(wallet.balance_cents);
    });
  }
  return users.map((row) => ({
    ...row,
    balance: balances[row.id] != null ? balances[row.id] : 0,
  }));
}

async function fetchAccountsForList(client, listId) {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("accounts")
      .select("id,login,price,account_status")
      .eq("list_id", listId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function attachListAccounts(client, list) {
  if (!list) return list;
  const rows = await fetchAccountsForList(client, list.id);
  return {
    ...list,
    accounts: rows.map((row) => ({
      id: row.id,
      login: row.login,
      price: row.price,
      account_status: row.account_status,
    })),
  };
}

export const adminRouter = Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

adminRouter.use(requireAdmin);

function fileUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File is too large. Maximum is 50 MB." });
      return;
    }
    res.status(400).json({ error: err.message || "Could not read upload." });
  });
}

function decodeUploadBuffer(buffer) {
  let text = Buffer.from(buffer).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

async function acceptImport(res, raw, body) {
  const client = getSupabaseAdmin();
  const opts = listOptions(body);
  const { list, raw: trimmed } = await acceptListImport(client, raw, opts);
  enqueueListProcess({ listId: list.id, raw: trimmed, price: opts.price });
  res.status(202).json({ accepted: true, list });
}

adminRouter.get("/lists", async (_req, res) => {
  try {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from("lists")
      .select(LIST_INDEX_COLUMNS)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load lists." });
  }
});

adminRouter.get("/lists/:id", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from("lists")
      .select(LIST_DETAIL_COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "List not found." });
      return;
    }
    res.json(await attachListAccounts(client, data));
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load list." });
  }
});

adminRouter.patch("/lists/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const content = typeof body.content === "string" ? body.content : null;
    const name = typeof body.name === "string" ? body.name.trim() : null;
    if (content == null && name == null) {
      res.status(400).json({ error: "List content is required." });
      return;
    }
    if (name != null && !name) {
      res.status(400).json({ error: "Give this list a name." });
      return;
    }
    const patch = { updated_at: new Date().toISOString() };
    if (content != null) patch.content = content;
    if (name != null) patch.name = name;
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from("lists")
      .update(patch)
      .eq("id", req.params.id)
      .select(LIST_DETAIL_COLUMNS)
      .maybeSingle();
    if (error) throw friendlyListError(error);
    if (!data) {
      res.status(404).json({ error: "List not found." });
      return;
    }
    res.json(await attachListAccounts(client, data));
  } catch (err) {
    res.status(clientIngestStatus(err)).json({ error: err.message || "Could not update list." });
  }
});

adminRouter.delete("/lists/:id", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from("lists")
      .delete()
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "List not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not delete list." });
  }
});

adminRouter.get("/accounts", async (_req, res) => {
  try {
    const client = getSupabaseAdmin();
    const rows = await fetchAccountRows(
      client,
      "id,login,country,state,outbound,inbound,card_number,expiry,price,account_status,created_at,updated_at,list_id,sort_order,lists(name)"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load accounts." });
  }
});

adminRouter.get("/users", async (_req, res) => {
  try {
    const client = getSupabaseAdmin();
    const rows = await fetchAccessTokenUsers(client);
    res.json(await attachWalletBalances(client, rows));
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load users." });
  }
});

async function fetchPurchases(client) {
  const pageSize = 500;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("purchases")
      .select("id, owner_key, telegram_user_id, account_data, total_usd, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function attachPurchaseUsers(client, purchases) {
  if (!purchases.length) return purchases;
  const ownerKeys = [];
  const seen = Object.create(null);
  for (let i = 0; i < purchases.length; i++) {
    const key = String(purchases[i].owner_key || "").trim();
    if (!key || seen[key]) continue;
    seen[key] = true;
    ownerKeys.push(key);
  }
  const usersById = Object.create(null);
  const chunks = inChunks(ownerKeys, 200);
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].length) continue;
    const { data, error } = await client
      .from("access_tokens")
      .select(USER_COLUMNS)
      .in("id", chunks[i]);
    if (error) throw error;
    (data || []).forEach((user) => {
      usersById[user.id] = user;
    });
  }
  return purchases.map((row) => {
    const user = usersById[row.owner_key] || null;
    const accounts = Array.isArray(row.account_data) ? row.account_data : [];
    return {
      id: row.id,
      owner_key: row.owner_key,
      telegram_user_id: row.telegram_user_id != null
        ? row.telegram_user_id
        : user && user.telegram_user_id != null
          ? user.telegram_user_id
          : null,
      telegram_username: user ? user.telegram_username : null,
      telegram_first_name: user ? user.telegram_first_name : null,
      telegram_last_name: user ? user.telegram_last_name : null,
      total_usd: row.total_usd,
      created_at: row.created_at,
      account_count: accounts.length,
      accounts: accounts.map((acct) => ({
        id: acct && acct.id != null ? acct.id : null,
        login: acct && acct.login != null ? String(acct.login) : "",
        price: acct && acct.price != null ? Number(acct.price) || 0 : 0,
        vendor: acct && acct.vendor != null ? String(acct.vendor) : "",
        country: acct && acct.country != null ? String(acct.country) : "",
        account_status: acct && acct.account_status != null ? String(acct.account_status) : "",
      })),
    };
  });
}

adminRouter.get("/purchases", async (_req, res) => {
  try {
    const client = getSupabaseAdmin();
    const rows = await fetchPurchases(client);
    res.json(await attachPurchaseUsers(client, rows));
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load purchases." });
  }
});

const REFUND_COLUMNS =
  "id, purchase_id, owner_key, telegram_user_id, account_id, account_login, carrier," +
  " amount_usd, reason_code, reason_note, screenshot_url, status, refund_number, refunded_usd," +
  " resolved_at, created_at";

async function usersByOwnerKey(client, ownerKeys) {
  const usersById = Object.create(null);
  const chunks = inChunks(ownerKeys, 200);
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].length) continue;
    const { data, error } = await client
      .from("access_tokens")
      .select(USER_COLUMNS)
      .in("id", chunks[i]);
    if (error) throw error;
    (data || []).forEach((user) => {
      usersById[user.id] = user;
    });
  }
  return usersById;
}

function shapeRefundCase(row, user) {
  return {
    id: row.id,
    created_at: row.created_at,
    owner_key: row.owner_key,
    telegram_user_id:
      row.telegram_user_id != null
        ? row.telegram_user_id
        : user && user.telegram_user_id != null
          ? user.telegram_user_id
          : null,
    telegram_username: user ? user.telegram_username : null,
    telegram_first_name: user ? user.telegram_first_name : null,
    telegram_last_name: user ? user.telegram_last_name : null,
    account_login: row.account_login,
    carrier: row.carrier,
    reason: refundReasonLabel(row.reason_code),
    reason_note: row.reason_note,
    screenshot_url: row.screenshot_url,
    amount_usd: row.amount_usd,
    status: row.status,
    refund_number: row.refund_number,
    refunded_usd: row.refunded_usd,
    resolved_at: row.resolved_at,
  };
}

adminRouter.get("/refunds", async (_req, res) => {
  try {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from("refund_cases")
      .select(REFUND_COLUMNS)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = data || [];
    const ownerKeys = uniqueIds(rows.map((row) => row.owner_key));
    const usersById = rows.length ? await usersByOwnerKey(client, ownerKeys) : {};
    res.json(rows.map((row) => shapeRefundCase(row, usersById[row.owner_key] || null)));
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load refunds." });
  }
});

/** Moves a case out of `pending` exactly once, so a double click cannot review twice. */
async function claimPendingRefundCase(client, id) {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("refund_cases")
    .update({ status: "reviewed", resolved_at: now, updated_at: now })
    .eq("id", id)
    .eq("status", "pending")
    .select(REFUND_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data;
}

adminRouter.post("/refunds/:id/review", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const refundCase = await claimPendingRefundCase(client, String(req.params.id || "").trim());
    if (!refundCase) {
      res.status(409).json({ error: "This refund case is no longer pending." });
      return;
    }
    res.json({ ok: true, status: "reviewed", refund_number: refundCase.refund_number });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not mark this refund reviewed." });
  }
});

adminRouter.get("/users/:id/activity", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const id = String(req.params.id || "").trim();
    const { data: user, error } = await client
      .from("access_tokens")
      .select(USER_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    await backfillDepositActivity(user.id);
    const { data: activity, error: actError } = await client
      .from("user_activity")
      .select("id, action, amount_usd, from_address, details, created_at")
      .eq("owner_key", user.id)
      .order("created_at", { ascending: false });
    if (actError) throw actError;
    const wallet = await getWalletByOwnerKey(user.id);
    res.json({
      user: {
        ...user,
        balance: wallet ? dollarsFromCents(wallet.balance_cents) : 0,
      },
      activity: activity || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load activity." });
  }
});

adminRouter.post("/users/:id/credit", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const id = String(req.params.id || "").trim();
    const { data: user, error } = await client
      .from("access_tokens")
      .select(USER_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const result = await creditWalletManually(user.id, req.body && req.body.amount);
    res.json({
      ok: true,
      amount: result.amount,
      balance: result.balance,
      user: { ...user, balance: result.balance },
    });
  } catch (err) {
    const msg = err.message || "Could not add balance.";
    const status = err.status || (/Enter an amount|two decimal|positive amount|too large/i.test(msg) ? 400 : 500);
    res.status(status).json({ error: msg });
  }
});

adminRouter.post("/users/:id/debit", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const id = String(req.params.id || "").trim();
    const { data: user, error } = await client
      .from("access_tokens")
      .select(USER_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const result = await debitWalletManually(user.id, req.body && req.body.amount);
    res.json({
      ok: true,
      amount: result.amount,
      balance: result.balance,
      user: { ...user, balance: result.balance },
    });
  } catch (err) {
    const msg = err.message || "Could not deduct balance.";
    const status = err.status || (/Enter an amount|two decimal|positive amount|too large|current balance/i.test(msg) ? 400 : 500);
    res.status(status).json({ error: msg });
  }
});

adminRouter.post("/notify", async (req, res) => {
  try {
    if (!telegramBotConfigured()) {
      res.status(503).json({ error: "Telegram bot token is not set." });
      return;
    }
    const message = parseNotifyMessage(req.body);
    let telegramUserId;
    try {
      telegramUserId = parseTelegramUserId(req.body && req.body.telegramUserId);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const client = getSupabaseAdmin();
    let targets;
    if (telegramUserId != null) {
      const { data, error } = await client
        .from("access_tokens")
        .select("telegram_user_id")
        .eq("telegram_user_id", telegramUserId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      targets = [data.telegram_user_id];
    } else {
      const users = await fetchAccessTokenUsers(client);
      targets = users.map((row) => row.telegram_user_id).filter(Boolean);
    }
    if (!targets.length) {
      res.status(400).json({ error: "No users to message." });
      return;
    }
    let sent = 0;
    let failed = 0;
    const errors = [];
    for (let i = 0; i < targets.length; i++) {
      try {
        await sendTelegramMessage(targets[i], message);
        sent += 1;
      } catch (err) {
        failed += 1;
        if (errors.length < 5) {
          errors.push({
            telegramUserId: targets[i],
            error: err.message || "Send failed.",
          });
        }
      }
      if (i < targets.length - 1) {
        await sleep(40);
      }
    }
    res.json({ sent, failed, total: targets.length, errors });
  } catch (err) {
    const msg = err.message || "Could not send message.";
    const status = /Enter a message|too long|No users/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

const MAX_PRICE_IDS = 500;
const MAX_ORDER_IDS = 5000;

adminRouter.patch("/accounts/price", async (req, res) => {
  try {
    const ids = uniqueIds(req.body && req.body.ids);
    if (!ids.length) {
      res.status(400).json({ error: "Select at least one account." });
      return;
    }
    if (ids.length > MAX_PRICE_IDS) {
      res.status(400).json({ error: "Too many accounts. Update at most 500 at a time." });
      return;
    }
    const price = parsePrice(req.body && req.body.price);
    const client = getSupabaseAdmin();
    const now = new Date().toISOString();
    const chunks = inChunks(ids, 120);
    for (let i = 0; i < chunks.length; i++) {
      const { error } = await client
        .from("accounts")
        .update({ price, updated_at: now })
        .in("id", chunks[i]);
      if (error) throw error;
    }
    res.json({ ok: true, updated: ids.length, price });
  } catch (err) {
    const msg = err.message || "Could not update price.";
    const status = /Enter a price|valid price|Select at least|Too many/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

adminRouter.patch("/accounts/status", async (req, res) => {
  try {
    const ids = uniqueIds(req.body && req.body.ids);
    if (!ids.length) {
      res.status(400).json({ error: "Select at least one account." });
      return;
    }
    if (ids.length > MAX_PRICE_IDS) {
      res.status(400).json({ error: "Too many accounts. Update at most 500 at a time." });
      return;
    }
    const accountStatus = parseAccountStatus(
      (req.body && (req.body.accountStatus || req.body.account_status)) || "",
      true
    );
    const client = getSupabaseAdmin();
    const now = new Date().toISOString();
    const chunks = inChunks(ids, 120);
    for (let i = 0; i < chunks.length; i++) {
      const { error } = await client
        .from("accounts")
        .update({ account_status: accountStatus, updated_at: now })
        .in("id", chunks[i]);
      if (error) throw error;
    }
    res.json({ ok: true, updated: ids.length, accountStatus });
  } catch (err) {
    const msg = err.message || "Could not update account status.";
    const status = /account status|Active or Cash|Select at least|Too many/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

adminRouter.patch("/accounts/order", async (req, res) => {
  try {
    const ids = uniqueIds(req.body && req.body.ids);
    if (!ids.length) {
      res.status(400).json({ error: "Account order is required." });
      return;
    }
    if (ids.length > MAX_ORDER_IDS) {
      res.status(400).json({ error: "Too many accounts. Reorder at most 5000 at a time." });
      return;
    }
    const client = getSupabaseAdmin();
    const chunks = inChunks(
      ids.map((id, index) => ({ id, index })),
      40
    );
    for (let i = 0; i < chunks.length; i++) {
      const results = await Promise.all(
        chunks[i].map(({ id, index }) =>
          client.from("accounts").update({ sort_order: index }).eq("id", id)
        )
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].error) throw results[j].error;
      }
    }
    res.json({ ok: true, updated: ids.length });
  } catch (err) {
    const msg = err.message || "Could not save order.";
    const status = /Account order is required|Too many/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

adminRouter.post("/accounts/delete", async (req, res) => {
  try {
    const ids = uniqueIds(req.body && req.body.ids);
    if (!ids.length) {
      res.status(400).json({ error: "Select at least one account." });
      return;
    }
    if (ids.length > MAX_PRICE_IDS) {
      res.status(400).json({ error: "Too many accounts. Delete at most 500 at a time." });
      return;
    }
    const client = getSupabaseAdmin();
    const chunks = inChunks(ids, 120);
    for (let i = 0; i < chunks.length; i++) {
      const { error } = await client.from("accounts").delete().in("id", chunks[i]);
      if (error) throw error;
    }
    res.json({ ok: true, deleted: ids.length });
  } catch (err) {
    const msg = err.message || "Could not delete accounts.";
    const status = /Select at least|Too many/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

adminRouter.delete("/accounts/:id", async (req, res) => {
  try {
    const client = getSupabaseAdmin();
    const { error } = await client.from("accounts").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not delete account." });
  }
});

adminRouter.post("/paste", async (req, res) => {
  try {
    await acceptImport(res, req.body && req.body.rawText, req.body);
  } catch (err) {
    const msg = err.message || "Could not import accounts.";
    res.status(clientIngestStatus(err)).json({ error: msg });
  }
});

adminRouter.post("/paste/upload", fileUpload, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: "Choose a text file with list content." });
      return;
    }
    await acceptImport(res, decodeUploadBuffer(req.file.buffer), req.body);
  } catch (err) {
    const msg = err.message || "Could not import accounts.";
    res.status(clientIngestStatus(err)).json({ error: msg });
  }
});

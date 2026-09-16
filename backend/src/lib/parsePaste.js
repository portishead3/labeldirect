function stripBrackets(value) {
  return String(value || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
}

function parseIntSafe(value) {
  const n = parseInt(String(value || "").replace(/[^\d-]/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

function normalizeKey(key) {
  return String(key || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function firstFilled(fields, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const value = fields[aliases[i]];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function expiryFromText(text) {
  const match = String(text || "").match(/\b(0?[1-9]|1[0-2])\/(\d{4}|\d{2})\b/);
  return match ? match[0].replace(/^(\d)\//, "0$1/") : "";
}

const ZIP3_STATE = [
  [5, 5, "NY"],
  [6, 9, "PR"],
  [10, 27, "MA"],
  [28, 29, "RI"],
  [30, 38, "NH"],
  [39, 49, "ME"],
  [50, 59, "VT"],
  [60, 69, "CT"],
  [70, 89, "NJ"],
  [90, 99, "AE"],
  [100, 149, "NY"],
  [150, 196, "PA"],
  [197, 199, "DE"],
  [200, 205, "DC"],
  [206, 219, "MD"],
  [220, 246, "VA"],
  [247, 268, "WV"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [300, 319, "GA"],
  [320, 349, "FL"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [386, 397, "MS"],
  [398, 399, "GA"],
  [400, 427, "KY"],
  [430, 459, "OH"],
  [460, 479, "IN"],
  [480, 499, "MI"],
  [500, 528, "IA"],
  [530, 549, "WI"],
  [550, 567, "MN"],
  [570, 577, "SD"],
  [580, 588, "ND"],
  [590, 599, "MT"],
  [600, 629, "IL"],
  [630, 658, "MO"],
  [660, 679, "KS"],
  [680, 693, "NE"],
  [700, 714, "LA"],
  [716, 729, "AR"],
  [730, 749, "OK"],
  [750, 799, "TX"],
  [800, 816, "CO"],
  [820, 831, "WY"],
  [832, 838, "ID"],
  [840, 847, "UT"],
  [850, 865, "AZ"],
  [870, 884, "NM"],
  [889, 898, "NV"],
  [900, 961, "CA"],
  [967, 968, "HI"],
  [970, 979, "OR"],
  [980, 994, "WA"],
  [995, 999, "AK"],
];

function stateFromZip(zip) {
  const digits = String(zip || "").replace(/\D/g, "");
  if (digits.length < 5) return "";
  const prefix = parseInt(digits.slice(0, 3), 10);
  if (Number.isNaN(prefix)) return "";
  for (let i = 0; i < ZIP3_STATE.length; i++) {
    const row = ZIP3_STATE[i];
    if (prefix >= row[0] && prefix <= row[1]) return row[2];
  }
  return "";
}

function stateFromAddress(address) {
  const parts = String(address || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return "";
  const second = parts[1];
  if (/^[A-Za-z]{2}$/.test(second)) return second.toUpperCase();
  for (let i = 0; i < parts.length; i++) {
    const zipState = stateFromZip(parts[i]);
    if (zipState) return zipState;
  }
  return "";
}

export function parseLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const parts = text.split(/\s*\|\s*/);
  const login = parts[0].trim();
  if (!login || !login.includes(":")) return null;
  const fields = {};
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const eq = chunk.indexOf("=");
    if (eq === -1) continue;
    const key = normalizeKey(chunk.slice(0, eq));
    if (!key) continue;
    fields[key] = stripBrackets(chunk.slice(eq + 1));
  }
  const address = firstFilled(fields, ["address"]);
  const card = firstFilled(fields, [
    "creditcardnumber",
    "cardnumber",
    "cardno",
    "ccnumber",
    "ccn",
    "card",
  ]);
  return {
    login,
    country: firstFilled(fields, ["countrycode", "country"]),
    state:
      firstFilled(fields, [
        "stateorprovincecode",
        "stateprovincecode",
        "statecode",
        "provincecode",
        "state",
        "province",
        "region",
      ]) || stateFromAddress(address),
    outbound: parseIntSafe(firstFilled(fields, ["outbound"])),
    inbound: parseIntSafe(firstFilled(fields, ["inbound"])),
    card_number: card.replace(/\s+/g, ""),
    expiry:
      expiryFromText(
        firstFilled(fields, [
          "expirationdate",
          "expiration",
          "expiry",
          "expdate",
          "cardexpiry",
          "validthru",
        ])
      ) || expiryFromText(card) || expiryFromText(text),
  };
}

export function parsePaste(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map(parseLine)
    .filter(Boolean);
}

export function groupByLogin(rows) {
  const map = {};
  for (const row of rows) {
    if (!map[row.login]) map[row.login] = [];
    map[row.login].push(row);
  }
  return map;
}

export function accountPayload(row, listId) {
  const payload = {
    login: row.login,
    country: row.country,
    state: row.state,
    outbound: row.outbound,
    inbound: row.inbound,
    card_number: row.card_number,
    expiry: row.expiry,
    updated_at: new Date().toISOString(),
  };
  if (row.price != null && row.price !== "") payload.price = Number(row.price);
  if (listId) payload.list_id = listId;
  return payload;
}

function filled(value) {
  return String(value == null ? "" : value).trim();
}

function mergeAccount(existing, payload) {
  const next = { ...payload };
  ["country", "state", "card_number", "expiry"].forEach((key) => {
    if (!filled(next[key]) && filled(existing[key])) next[key] = existing[key];
  });
  return next;
}

function inChunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function loginsFromContent(raw) {
  const logins = [];
  const seen = Object.create(null);
  String(raw || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const login = String(line || "")
        .trim()
        .split("|")[0]
        .trim();
      if (!login.includes(":") || seen[login]) return;
      seen[login] = true;
      logins.push(login);
    });
  return logins;
}

export async function fetchByLogins(client, logins, columns) {
  if (!logins.length) return [];
  const select = columns || "id,login,country,state,card_number,expiry";
  const rows = [];
  const chunks = inChunks(logins, 120);
  for (let i = 0; i < chunks.length; i += 4) {
    const batch = chunks.slice(i, i + 4);
    const parts = await Promise.all(
      batch.map(async (chunk) => {
        const { data, error } = await client.from("accounts").select(select).in("login", chunk);
        if (error) throw error;
        return data || [];
      })
    );
    parts.forEach((part) => rows.push(...part));
  }
  return rows;
}

export async function processParsed(client, parsed, listId, price) {
  const grouped = groupByLogin(parsed);
  const logins = Object.keys(grouped);
  let inserted = 0;
  let updated = 0;
  let duped = 0;

  const accountRows = await fetchByLogins(client, logins);
  const accountMap = Object.fromEntries(accountRows.map((r) => [r.login, r]));

  const accountInserts = [];
  const accountUpdates = [];

  for (const login of logins) {
    const occurrences = grouped[login];
    const latest = occurrences[occurrences.length - 1];
    const withPrice = price == null ? latest : { ...latest, price };
    const payload = accountPayload(withPrice, listId);
    if (accountMap[login]) {
      accountUpdates.push({
        id: accountMap[login].id,
        payload: mergeAccount(accountMap[login], payload),
      });
      if (occurrences.length > 1) duped += occurrences.length - 1;
      continue;
    }
    if (occurrences.length > 1) {
      duped += occurrences.length;
      continue;
    }
    accountInserts.push(payload);
  }

  for (const chunk of inChunks(accountUpdates, 200)) {
    const rows = chunk.map((item) => ({ id: item.id, ...item.payload }));
    const { error } = await client.from("accounts").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    updated += chunk.length;
  }

  for (const chunk of inChunks(accountInserts, 200)) {
    const { error } = await client.from("accounts").insert(chunk);
    if (error) throw error;
    inserted += chunk.length;
  }

  return { inserted, updated, duped, parsed: parsed.length };
}

function friendlyListError(err) {
  const msg = String(err && err.message ? err.message : err || "");
  if (/duplicate key|unique/i.test(msg)) {
    return new Error("A list with that name already exists.");
  }
  return err instanceof Error ? err : new Error(msg || "Could not save list.");
}

export async function saveOrAppendList(client, raw, { attachListId, listName, price } = {}) {
  const trimmed = String(raw || "").trim();
  const attachId = String(attachListId || "").trim();
  const name = String(listName || "").trim();
  const now = new Date().toISOString();
  const listPrice = price == null ? null : Number(price);

  if (attachId) {
    const { data: existing, error: fetchErr } = await client
      .from("lists")
      .select("id,name,content")
      .eq("id", attachId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) throw new Error("That list is no longer available.");
    const prev = String(existing.content || "").trimEnd();
    const content = prev ? prev + "\n" + trimmed : trimmed;
    const patch = {
      content,
      updated_at: now,
      process_status: "processing",
      process_error: null,
      process_stats: null,
    };
    if (listPrice != null && Number.isFinite(listPrice)) patch.price = listPrice;
    const { data, error } = await client
      .from("lists")
      .update(patch)
      .eq("id", existing.id)
      .select("id,name,process_status")
      .single();
    if (error) throw error;
    return data;
  }

  if (!name) {
    throw new Error("Give this list a name, or attach it to an existing one.");
  }

  const insertRow = {
    name,
    content: trimmed,
    updated_at: now,
    process_status: "processing",
    process_error: null,
    process_stats: null,
  };
  if (listPrice != null && Number.isFinite(listPrice)) insertRow.price = listPrice;
  const { data, error } = await client
    .from("lists")
    .insert(insertRow)
    .select("id,name,process_status")
    .single();
  if (error) throw friendlyListError(error);
  return data;
}

function hasLikelyAccountLine(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .some((line) => {
      const login = line.trim().split("|")[0] || "";
      return login.includes(":");
    });
}

export async function acceptListImport(client, raw, listOpts) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    throw new Error("Paste a list first.");
  }
  if (!hasLikelyAccountLine(trimmed)) {
    throw new Error("No valid lines found. Each line must start with user:password | …");
  }
  const list = await saveOrAppendList(client, trimmed, listOpts || {});
  return { list, raw: trimmed };
}

export async function processAcceptedImport(client, listId, raw, price) {
  const parsed = parsePaste(raw);
  if (!parsed.length) {
    throw new Error("No valid lines found. Each line must start with user:password | …");
  }
  return processParsed(client, parsed, listId, price);
}

export async function backfillAccountsFromLists(client) {
  const { data: lists, error: listErr } = await client.from("lists").select("id,content");
  if (listErr) throw listErr;
  const byLogin = {};
  for (const list of lists || []) {
    const rows = parsePaste(list.content);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      byLogin[row.login] = { row, listId: list.id };
    }
  }
  const logins = Object.keys(byLogin);
  const existing = await fetchByLogins(client, logins);
  let updated = 0;
  const payloads = existing.map((current) => {
    const found = byLogin[current.login];
    if (!found) return null;
    const payload = mergeAccount(current, accountPayload(found.row, found.listId));
    delete payload.updated_at;
    return { id: current.id, ...payload };
  }).filter(Boolean);

  for (const chunk of inChunks(payloads, 200)) {
    const { error } = await client.from("accounts").upsert(chunk, { onConflict: "id" });
    if (error) throw error;
    updated += chunk.length;
  }
  return { updated, matched: existing.length, parsedLogins: logins.length };
}

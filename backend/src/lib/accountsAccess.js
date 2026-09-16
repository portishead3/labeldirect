import crypto from "node:crypto";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function accessSecret() {
  return String(process.env.ACCOUNTS_ACCESS_TOKEN || "");
}

export function tokensEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (!left.length || left.length !== right.length) {
    const dummy = Buffer.alloc(32);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function createAccountsSession(options) {
  const secret = accessSecret();
  const sub = options && options.sub != null ? String(options.sub) : "";
  const payloadObj = { v: 1, exp: Date.now() + SESSION_MS };
  if (sub) payloadObj.sub = sub;
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function parseAccountsSession(token) {
  const secret = accessSecret();
  if (!secret || !token) return { ok: false };
  const parts = String(token).split(".");
  if (parts.length !== 2) return { ok: false };
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!tokensEqual(sig, expected)) return { ok: false };
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(data.exp) <= Date.now()) return { ok: false };
    return {
      ok: true,
      sub: data.sub != null ? String(data.sub) : "",
      exp: Number(data.exp),
    };
  } catch {
    return { ok: false };
  }
}

export function verifyAccountsSession(token) {
  return parseAccountsSession(token).ok;
}

export function hashAccessToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function isAccountsAccessConfigured() {
  return Boolean(accessSecret());
}

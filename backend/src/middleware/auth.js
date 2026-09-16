import { getAuthVerifier } from "../supabaseAdmin.js";
import { parseAccountsSession } from "../lib/accountsAccess.js";

export function requireAccountsAccess(req, res, next) {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const session = match ? parseAccountsSession(match[1]) : { ok: false };
  if (!session.ok) {
    res.status(401).json({ error: "Sign in with your access token to view accounts." });
    return;
  }
  req.accountsSub = session.sub || "";
  req.accountsSessionToken = match[1];
  next();
}

export function requireWalletAccess(req, res, next) {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const session = match ? parseAccountsSession(match[1]) : { ok: false };
  if (!session.ok) {
    res.status(401).json({ error: "Sign in with your access token to view accounts." });
    return;
  }
  if (!session.sub) {
    res.status(401).json({ error: "Sign in again to use your wallet." });
    return;
  }
  req.accountsSub = session.sub;
  req.accountsSessionToken = match[1];
  next();
}

export async function requireAdmin(req, res, next) {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Missing Authorization Bearer token." });
    return;
  }
  try {
    const verifier = getAuthVerifier();
    const { data, error } = await verifier.auth.getUser(match[1]);
    if (error || !data.user) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    req.adminUser = data.user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message || "Auth check failed." });
  }
}

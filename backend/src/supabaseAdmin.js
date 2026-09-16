import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
};

let adminClient = null;
let authVerifier = null;

export function getSupabaseAdmin() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  }
  adminClient = createClient(url, key, clientOptions);
  return adminClient;
}

/** Verifies admin JWTs (uses anon key + getUser). */
export function getAuthVerifier() {
  if (authVerifier) return authVerifier;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in backend/.env");
  }
  authVerifier = createClient(url, anon, clientOptions);
  return authVerifier;
}

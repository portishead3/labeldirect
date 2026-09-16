-- Phase 3: run AFTER the API works with SUPABASE_SERVICE_ROLE_KEY.
-- Browsers (anon + authenticated JWT) can no longer read/write tables directly.

revoke all on public.accounts from anon, authenticated;
revoke all on public.access_tokens from anon, authenticated;

drop policy if exists "Public can read accounts" on public.accounts;
drop policy if exists "Authenticated can insert accounts" on public.accounts;
drop policy if exists "Authenticated can update accounts" on public.accounts;
drop policy if exists "Authenticated can delete accounts" on public.accounts;


-- Access tokens issued by the Telegram bot after channel membership check.
-- Service role only; browsers must not read this table.

create table if not exists public.access_tokens (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.access_tokens enable row level security;

revoke all on public.access_tokens from anon, authenticated;
grant all on public.access_tokens to service_role;

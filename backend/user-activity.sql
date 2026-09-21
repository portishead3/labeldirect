-- Client action history (logins, deposits, purchases). Service role only.

create table if not exists public.user_activity (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null,
  telegram_user_id bigint,
  action text not null,
  amount_usd numeric(12, 2),
  from_address text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_activity_owner_created_idx
  on public.user_activity (owner_key, created_at desc);

create index if not exists user_activity_telegram_user_id_idx
  on public.user_activity (telegram_user_id);

create unique index if not exists user_activity_deposit_action_idx
  on public.user_activity (owner_key, action, ((details->>'deposit_id')))
  where (details ? 'deposit_id');

alter table public.user_activity enable row level security;

revoke all on public.user_activity from anon, authenticated;
grant all on public.user_activity to service_role;

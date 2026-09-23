-- Refund cases opened by buyers on purchased accounts. Service role only.

create table if not exists public.refund_cases (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases (id) on delete cascade,
  owner_key text not null,
  telegram_user_id bigint,
  account_id text,
  account_login text not null default '',
  carrier text not null default 'FedEx',
  amount_usd numeric(12, 2) not null default 0,
  reason_code text not null check (
    reason_code in ('login_incorrect', 'payment_expired', 'cannot_make_label', 'other')
  ),
  reason_note text,
  screenshot_url text,
  status text not null default 'open' check (status in ('open', 'approved', 'declined')),
  refunded_usd numeric(12, 2),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists refund_cases_purchase_login_idx
  on public.refund_cases (purchase_id, account_login);

create index if not exists refund_cases_owner_created_idx
  on public.refund_cases (owner_key, created_at desc);

create index if not exists refund_cases_status_idx
  on public.refund_cases (status);

alter table public.refund_cases enable row level security;

revoke all on public.refund_cases from anon, authenticated;
grant all on public.refund_cases to service_role;

-- Wallet balances and NOWPayments deposit records. Service role only.

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null unique,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id) on delete restrict,
  amount_usd numeric(12, 2) not null check (amount_usd > 0),
  order_id text not null unique,
  nowpayments_invoice_id text,
  payment_status text not null default 'pending',
  credited_at timestamptz,
  raw_ipn jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deposits_wallet_id_idx on public.deposits (wallet_id);
create index if not exists deposits_payment_status_idx on public.deposits (payment_status);

alter table public.wallets enable row level security;
alter table public.deposits enable row level security;

revoke all on public.wallets from anon, authenticated;
revoke all on public.deposits from anon, authenticated;
grant all on public.wallets to service_role;
grant all on public.deposits to service_role;

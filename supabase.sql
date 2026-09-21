-- Run this in the Supabase SQL Editor if you are not applying migrations from Cursor.

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  carrier text not null check (carrier in ('ups', 'fedex')),
  login text not null default '',
  country text not null default '',
  outbound text not null default '',
  inbound text not null default '',
  cr_number text not null default '',
  expiry text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists listings_carrier_created_idx
  on public.listings (carrier, created_at desc);

alter table public.listings enable row level security;

drop policy if exists "Public can read listings" on public.listings;
create policy "Public can read listings"
  on public.listings
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can insert listings" on public.listings;
create policy "Authenticated can insert listings"
  on public.listings
  for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update listings" on public.listings;
create policy "Authenticated can update listings"
  on public.listings
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated can delete listings" on public.listings;
create policy "Authenticated can delete listings"
  on public.listings
  for delete
  to authenticated
  using (true);

create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  content text not null default '',
  price numeric(10,2),
  account_status text check (account_status is null or account_status in ('active', 'cash')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lists enable row level security;

revoke all on public.lists from anon, authenticated, public;
grant all on public.lists to service_role;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  login text not null unique,
  country text not null default '',
  state text not null default '',
  outbound integer not null default 0,
  inbound integer not null default 0,
  card_number text not null default '',
  expiry text not null default '',
  price numeric(10,2) not null default 0,
  account_status text check (account_status is null or account_status in ('active', 'cash')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists accounts_updated_idx on public.accounts (updated_at desc);

alter table public.accounts enable row level security;

revoke all on public.accounts from anon, authenticated, public;

grant all on public.accounts to authenticated;

grant select (id, login, country, state, outbound, inbound, expiry, created_at, updated_at)
  on public.accounts to anon;

drop policy if exists "Public can read accounts" on public.accounts;
create policy "Public can read accounts"
  on public.accounts
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can insert accounts" on public.accounts;
create policy "Authenticated can insert accounts"
  on public.accounts
  for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update accounts" on public.accounts;
create policy "Authenticated can update accounts"
  on public.accounts
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated can delete accounts" on public.accounts;
create policy "Authenticated can delete accounts"
  on public.accounts
  for delete
  to authenticated
  using (true);

-- Website label orders. The customer is stored here and is not written
-- into the CALI group message. Service role only.

create table if not exists public.label_orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  owner_key text not null,
  telegram_user_id bigint,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  carrier text not null,
  mode text not null,
  status text not null default 'pending',
  label_path text,
  invoice_path text,
  telegram_message_id bigint,
  order_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint label_orders_status_check check (status in ('pending', 'delivered'))
);

create index if not exists label_orders_owner_created_idx
  on public.label_orders (owner_key, created_at desc);

alter table public.label_orders enable row level security;

revoke all on public.label_orders from anon, authenticated;
grant all on public.label_orders to service_role;

alter table public.label_orders add column if not exists status text not null default 'pending';
alter table public.label_orders add column if not exists label_path text;
alter table public.label_orders add column if not exists invoice_path text;

alter table public.label_orders drop constraint if exists label_orders_status_check;
alter table public.label_orders
  add constraint label_orders_status_check check (status in ('pending', 'delivered'));

insert into storage.buckets (id, name, public)
values ('label-orders', 'label-orders', false)
on conflict (id) do update set public = false;

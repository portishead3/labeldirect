-- Refund cases opened by buyers on purchased accounts. Service role only.

create sequence if not exists public.refund_cases_refund_number_seq;

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
  status text not null default 'pending' check (status in ('pending', 'reviewed')),
  refund_number integer not null default nextval('public.refund_cases_refund_number_seq'),
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

-- Databases created before numbering: assign Refund 1, 2, … and keep only pending or reviewed.
alter table public.refund_cases
  add column if not exists refund_number integer;

with numbered as (
  select id,
         row_number() over (order by created_at asc, id asc) as n
  from public.refund_cases
  where refund_number is null
)
update public.refund_cases as cases
set refund_number = numbered.n + coalesce(
  (select max(existing.refund_number) from public.refund_cases as existing where existing.refund_number is not null),
  0
)
from numbered
where cases.id = numbered.id;

select setval(
  'public.refund_cases_refund_number_seq',
  coalesce((select max(refund_number) from public.refund_cases), 1),
  (select count(*) from public.refund_cases) > 0
);

alter table public.refund_cases
  alter column refund_number set default nextval('public.refund_cases_refund_number_seq');

alter sequence public.refund_cases_refund_number_seq
  owned by public.refund_cases.refund_number;

alter table public.refund_cases
  alter column refund_number set not null;

create unique index if not exists refund_cases_refund_number_idx
  on public.refund_cases (refund_number);

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'refund_cases'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
  loop
    execute format('alter table public.refund_cases drop constraint %I', constraint_name);
  end loop;
end $$;

update public.refund_cases
set status = 'pending'
where status = 'open';

update public.refund_cases
set status = 'reviewed'
where status in ('approved', 'declined');

alter table public.refund_cases
  drop constraint if exists refund_cases_status_check;

alter table public.refund_cases
  add constraint refund_cases_status_check
  check (status in ('pending', 'reviewed'));

alter table public.refund_cases
  alter column status set default 'pending';

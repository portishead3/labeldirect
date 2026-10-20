-- Security hardening (already applied to the production project via migrations
-- `lockdown_public_tables_service_role_only` and `atomic_wallet_and_purchase_functions`).
-- Kept here so a fresh environment can be rebuilt the same way.
--
-- Admin access is also gated in the API by auth.users.raw_app_meta_data->>'role' = 'admin'.
-- Grant it to an admin (service role / SQL editor only; users cannot edit app_metadata):
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
--    where email = 'you@example.com';

-- 1) Lock down: all data access goes through the backend using the service role.
drop policy if exists "Authenticated can delete accounts" on public.accounts;
drop policy if exists "Authenticated can insert accounts" on public.accounts;
drop policy if exists "Authenticated can update accounts" on public.accounts;
drop policy if exists "Public can read accounts" on public.accounts;
drop policy if exists "Authenticated can manage lists" on public.lists;
drop policy if exists "Authenticated can delete listings" on public.listings;
drop policy if exists "Authenticated can insert listings" on public.listings;
drop policy if exists "Authenticated can update listings" on public.listings;
drop policy if exists "Public can read listings" on public.listings;
drop policy if exists "Authenticated can manage duplicates" on public.duplicates;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
  end loop;
end $$;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 2) Atomic money operations (row-locked, single transaction).

create or replace function public.wallet_adjust(p_wallet_id uuid, p_delta_cents bigint)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_balance bigint;
begin
  update public.wallets
     set balance_cents = balance_cents + p_delta_cents,
         updated_at = now()
   where id = p_wallet_id
  returning balance_cents into v_balance;
  if not found then
    raise exception 'wallet_not_found';
  end if;
  return v_balance; -- wallets_balance_cents_check rejects results below zero
end;
$$;

create or replace function public.apply_deposit_credit(p_deposit_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_dep public.deposits%rowtype;
  v_add bigint;
  v_balance bigint;
  v_owner text;
begin
  select * into v_dep from public.deposits where id = p_deposit_id for update;
  if not found or v_dep.credited_at is not null
     or lower(coalesce(v_dep.payment_status, '')) not in ('finished', 'confirmed') then
    return jsonb_build_object('credited', false);
  end if;

  v_add := round(v_dep.amount_usd * 100)::bigint;
  update public.wallets
     set balance_cents = balance_cents + v_add, updated_at = now()
   where id = v_dep.wallet_id
  returning balance_cents, owner_key into v_balance, v_owner;
  if not found then
    raise exception 'wallet_not_found';
  end if;

  update public.deposits set credited_at = now(), updated_at = now() where id = v_dep.id;

  return jsonb_build_object(
    'credited', true,
    'add_cents', v_add,
    'balance_cents', v_balance,
    'owner_key', v_owner
  );
end;
$$;

create or replace function public.purchase_accounts(
  p_owner_key text,
  p_ids uuid[],
  p_telegram_user_id bigint,
  p_carriers jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_count int;
  v_total numeric;
  v_cents bigint;
  v_data jsonb;
  v_balance bigint;
  v_purchase_id uuid;
begin
  -- Serialise all spending for this wallet.
  select * into v_wallet from public.wallets where owner_key = p_owner_key for update;
  if not found then
    raise exception 'insufficient_balance' using detail = '0';
  end if;

  -- Serialise competing buyers of the same accounts; rows already bought vanish.
  perform 1 from public.accounts where id = any(p_ids) for update;

  select count(*),
         coalesce(sum(a.price), 0),
         coalesce(jsonb_agg(
           jsonb_build_object(
             'id', a.id,
             'login', a.login,
             'country', a.country,
             'state', a.state,
             'outbound', a.outbound,
             'inbound', a.inbound,
             'address', a.address,
             'billing', a.billing,
             'card_number', a.card_number,
             'expiry', a.expiry,
             'price', a.price,
             'account_status', a.account_status,
             'created_at', a.created_at,
             'updated_at', a.updated_at,
             'list_id', a.list_id,
             'sort_order', a.sort_order,
             'vendor', coalesce(l.name, ''),
             'carrier', case
               when lower(coalesce(
                 nullif(p_carriers ->> a.id::text, ''),
                 nullif(l.name, ''),
                 ''
               )) like '%ups%' then 'UPS'
               else 'FedEx'
             end
           ) order by a.id
         ), '[]'::jsonb)
    into v_count, v_total, v_data
    from public.accounts a
    left join public.lists l on l.id = a.list_id
   where a.id = any(p_ids);

  if v_count <> coalesce(array_length(p_ids, 1), 0) or v_count = 0 then
    raise exception 'accounts_unavailable';
  end if;

  v_cents := round(v_total * 100)::bigint;
  if v_wallet.balance_cents < v_cents then
    raise exception 'insufficient_balance' using detail = v_total::text;
  end if;

  update public.wallets
     set balance_cents = balance_cents - v_cents, updated_at = now()
   where id = v_wallet.id
  returning balance_cents into v_balance;

  insert into public.purchases (owner_key, telegram_user_id, account_data, total_usd)
  values (p_owner_key, p_telegram_user_id, v_data, v_total)
  returning id into v_purchase_id;

  delete from public.accounts where id = any(p_ids);

  return jsonb_build_object(
    'purchase_id', v_purchase_id,
    'account_data', v_data,
    'total_usd', v_total,
    'balance_cents', v_balance
  );
end;
$$;

revoke all on function public.wallet_adjust(uuid, bigint) from public, anon, authenticated;
revoke all on function public.apply_deposit_credit(uuid) from public, anon, authenticated;
revoke all on function public.purchase_accounts(text, uuid[], bigint, jsonb) from public, anon, authenticated;
grant execute on function public.wallet_adjust(uuid, bigint) to service_role;
grant execute on function public.apply_deposit_credit(uuid) to service_role;
grant execute on function public.purchase_accounts(text, uuid[], bigint, jsonb) to service_role;

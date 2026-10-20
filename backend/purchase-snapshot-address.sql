-- Store street address and billing on each purchase.
-- Bought rows are deleted from accounts, so the order page reads them from this snapshot.

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

revoke all on function public.purchase_accounts(text, uuid[], bigint, jsonb) from public, anon, authenticated;
grant execute on function public.purchase_accounts(text, uuid[], bigint, jsonb) to service_role;

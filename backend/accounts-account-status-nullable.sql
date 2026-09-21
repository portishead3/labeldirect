-- Status comes from pasted list fields only. Missing status is null, not a default.

alter table public.accounts
  alter column account_status drop default;

alter table public.accounts
  alter column account_status drop not null;

alter table public.accounts
  drop constraint if exists accounts_account_status_check;

alter table public.accounts
  add constraint accounts_account_status_check
  check (account_status is null or account_status in ('active', 'cash'));

update public.accounts
  set account_status = null
  where account_status = 'active';

-- Status is parsed from each pasted line (accountStatus=active|cash). Missing stays null.

alter table public.accounts
  add column if not exists account_status text;

alter table public.accounts
  drop constraint if exists accounts_account_status_check;

alter table public.accounts
  add constraint accounts_account_status_check
  check (account_status is null or account_status in ('active', 'cash'));

create index if not exists accounts_account_status_idx
  on public.accounts (account_status);

alter table public.lists
  add column if not exists account_status text;

alter table public.lists
  drop constraint if exists lists_account_status_check;

alter table public.lists
  add constraint lists_account_status_check
  check (account_status is null or account_status in ('active', 'cash'));

-- Street address taken from the Address field on pasted list lines.

alter table public.accounts
  add column if not exists address text not null default '';

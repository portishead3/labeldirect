-- Billing name taken from companyName, or billingFullname when companyName is empty.

alter table public.accounts
  add column if not exists billing text not null default '';

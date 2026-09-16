-- Manual display order for the public Accounts page (set by dragging on Full list).
-- Null means use the default: US first by outbound desc, then other countries the same way.

alter table public.accounts
  add column if not exists sort_order integer;

create index if not exists accounts_sort_order_idx
  on public.accounts (sort_order);

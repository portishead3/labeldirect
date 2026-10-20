-- Deleting a list should remove its accounts from the public accounts page.
alter table public.accounts
  drop constraint if exists accounts_list_id_fkey;

alter table public.accounts
  add constraint accounts_list_id_fkey
  foreign key (list_id) references public.lists (id)
  on delete cascade;

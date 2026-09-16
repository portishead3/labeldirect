-- Price stamped onto every account in an import (from the admin import dialog).
-- lists.price stores the last submitted import price so a restarted job can resume.

alter table public.accounts
  add column if not exists price numeric(10,2) not null default 0;

alter table public.lists
  add column if not exists price numeric(10,2);

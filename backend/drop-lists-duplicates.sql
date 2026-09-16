-- Optional: drop the unused duplicates table.
-- Do not drop public.lists — named imports still save there.

drop policy if exists "Authenticated can manage duplicates" on public.duplicates;

drop table if exists public.duplicates;

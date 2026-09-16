-- Processing status for async list ingest (paste / file upload).
alter table public.lists
  add column if not exists process_status text not null default 'idle',
  add column if not exists process_error text,
  add column if not exists process_stats jsonb;

alter table public.lists
  drop constraint if exists lists_process_status_check;

alter table public.lists
  add constraint lists_process_status_check
  check (process_status = any (array['idle'::text, 'processing'::text, 'ready'::text, 'error'::text]));

-- Inkwell notes — Supabase schema.
-- Paste this whole file into Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  title       text        not null default '',
  content     text        not null default '',
  tags        text[]      not null default '{}',
  pinned      boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Size guards (added separately so re-running on an existing table works).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notes_title_len' and conrelid = 'public.notes'::regclass) then
    alter table public.notes add constraint notes_title_len check (char_length(title) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notes_content_len' and conrelid = 'public.notes'::regclass) then
    alter table public.notes add constraint notes_content_len check (char_length(content) <= 200000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notes_tags_len' and conrelid = 'public.notes'::regclass) then
    alter table public.notes add constraint notes_tags_len check (cardinality(tags) <= 20);
  end if;
end $$;

-- If the table predates this script, make sure the ownership default exists.
alter table public.notes alter column user_id set default auth.uid();

-- List query: where user_id = ? order by updated_at desc
create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger (server clock is the source of truth)
-- ---------------------------------------------------------------------------
create or replace function public.notes_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  -- Ownership and creation time are immutable once a row exists.
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function public.notes_set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: each user can only see and change their own notes.
-- ---------------------------------------------------------------------------
alter table public.notes enable row level security;

drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Defence in depth: signed-out (anon) requests get no table access at all.
revoke all on table public.notes from anon;
revoke all on table public.notes from authenticated;
grant select, insert, update, delete on table public.notes to authenticated;

-- ---------------------------------------------------------------------------
-- Optional: Realtime. The app refreshes on focus / reconnect and does not need
-- it. If you add realtime later, uncomment:
-- alter publication supabase_realtime add table public.notes;
-- ---------------------------------------------------------------------------

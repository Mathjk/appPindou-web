-- appPindou v2 account and cloud snapshot schema.
-- Run this once in Supabase Dashboard -> SQL Editor.
-- The frontend uses only the project's publishable key; do not put service_role/secret keys in the app.

create extension if not exists citext with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext not null unique,
  recovery_email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username::text) between 3 and 32),
  constraint profiles_username_format check (username::text ~ '^[a-z0-9_-]+$')
);

create table if not exists public.app_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version integer not null default 1 check (version = 1),
  data jsonb not null,
  client_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists app_snapshots_set_updated_at on public.app_snapshots;
create trigger app_snapshots_set_updated_at
before update on public.app_snapshots
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  metadata_username text := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  metadata_recovery_email text := nullif(trim(coalesce(new.raw_user_meta_data->>'recovery_email', '')), '');
begin
  if metadata_username = '' then
    metadata_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 24);
  end if;

  insert into public.profiles (id, username, recovery_email)
  values (new.id, metadata_username, metadata_recovery_email)
  on conflict (id) do update
    set username = excluded.username,
        recovery_email = excluded.recovery_email,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

alter table public.profiles enable row level security;
alter table public.app_snapshots enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
on public.profiles
for delete
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "app_snapshots_select_own" on public.app_snapshots;
create policy "app_snapshots_select_own"
on public.app_snapshots
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "app_snapshots_insert_own" on public.app_snapshots;
create policy "app_snapshots_insert_own"
on public.app_snapshots
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "app_snapshots_update_own" on public.app_snapshots;
create policy "app_snapshots_update_own"
on public.app_snapshots
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "app_snapshots_delete_own" on public.app_snapshots;
create policy "app_snapshots_delete_own"
on public.app_snapshots
for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.profiles from anon;
revoke all on table public.app_snapshots from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.app_snapshots to authenticated;

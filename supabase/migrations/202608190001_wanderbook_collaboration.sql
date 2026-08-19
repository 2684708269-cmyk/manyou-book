-- Wanderbook: authentication profiles, invite-only shared maps, region marks and photos.
-- Run this migration in a Supabase project before configuring the frontend.

create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '旅行者',
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.maps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '我们的世界地图',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.map_members (
  map_id uuid not null references public.maps(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (map_id, user_id)
);

create table public.region_marks (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references public.maps(id) on delete cascade,
  region_key text not null,
  region_name text not null,
  country_name text not null,
  status text not null check (status in ('planned', 'visited')),
  note text not null default '' check (char_length(note) <= 500),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (map_id, region_key)
);

create table public.region_photos (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references public.maps(id) on delete cascade,
  region_key text not null,
  storage_path text not null unique,
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index map_members_user_id_idx on public.map_members(user_id);
create index maps_owner_id_idx on public.maps(owner_id);
create index region_marks_map_id_idx on public.region_marks(map_id);
create index region_photos_map_region_idx on public.region_photos(map_id, region_key);

create or replace function public.is_map_member(check_map_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.map_members
    where map_id = check_map_id and user_id = check_user_id
  );
$$;

revoke all on function public.is_map_member(uuid, uuid) from public;
grant execute on function public.is_map_member(uuid, uuid) to authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger maps_set_updated_at before update on public.maps
for each row execute function public.set_updated_at();
create trigger region_marks_set_updated_at before update on public.region_marks
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_map_id uuid;
  profile_name text;
begin
  profile_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    '旅行者'
  );

  insert into public.profiles (id, display_name)
  values (new.id, profile_name);

  insert into public.maps (owner_id, name)
  values (new.id, profile_name || '的世界地图')
  returning id into new_map_id;

  insert into public.map_members (map_id, user_id, role)
  values (new_map_id, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.join_map_by_invite(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_map_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select m.id into target_map_id
  from public.profiles p
  join public.maps m on m.owner_id = p.id
  where p.invite_code = upper(trim(p_invite_code))
  order by m.created_at asc
  limit 1;

  if target_map_id is null then
    raise exception 'INVALID_INVITE_CODE';
  end if;

  insert into public.map_members (map_id, user_id, role)
  values (target_map_id, auth.uid(), 'member')
  on conflict (map_id, user_id) do nothing;

  return target_map_id;
end;
$$;

revoke all on function public.join_map_by_invite(text) from public;
grant execute on function public.join_map_by_invite(text) to authenticated;

alter table public.profiles enable row level security;
alter table public.maps enable row level security;
alter table public.map_members enable row level security;
alter table public.region_marks enable row level security;
alter table public.region_photos enable row level security;

create policy "profiles_read_own" on public.profiles
for select to authenticated using (id = auth.uid());
create policy "profiles_update_own" on public.profiles
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "maps_read_members" on public.maps
for select to authenticated using (public.is_map_member(id));
create policy "maps_insert_owner" on public.maps
for insert to authenticated with check (owner_id = auth.uid());
create policy "maps_update_owner" on public.maps
for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "members_read_members" on public.map_members
for select to authenticated using (public.is_map_member(map_id));

create policy "marks_read_members" on public.region_marks
for select to authenticated using (public.is_map_member(map_id));
create policy "marks_insert_members" on public.region_marks
for insert to authenticated with check (
  public.is_map_member(map_id) and created_by = auth.uid() and updated_by = auth.uid()
);
create policy "marks_update_members" on public.region_marks
for update to authenticated using (public.is_map_member(map_id))
with check (public.is_map_member(map_id) and updated_by = auth.uid());
create policy "marks_delete_members" on public.region_marks
for delete to authenticated using (public.is_map_member(map_id));

create policy "photos_read_members" on public.region_photos
for select to authenticated using (public.is_map_member(map_id));
create policy "photos_insert_members" on public.region_photos
for insert to authenticated with check (public.is_map_member(map_id) and uploaded_by = auth.uid());
create policy "photos_delete_members" on public.region_photos
for delete to authenticated using (public.is_map_member(map_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'travel-photos',
  'travel-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "storage_read_map_members" on storage.objects
for select to authenticated using (
  bucket_id = 'travel-photos'
  and public.is_map_member(((storage.foldername(name))[1])::uuid)
);
create policy "storage_upload_map_members" on storage.objects
for insert to authenticated with check (
  bucket_id = 'travel-photos'
  and public.is_map_member(((storage.foldername(name))[1])::uuid)
  and owner_id = auth.uid()::text
);
create policy "storage_delete_map_members" on storage.objects
for delete to authenticated using (
  bucket_id = 'travel-photos'
  and public.is_map_member(((storage.foldername(name))[1])::uuid)
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'region_marks'
  ) then
    alter publication supabase_realtime add table public.region_marks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'region_photos'
  ) then
    alter publication supabase_realtime add table public.region_photos;
  end if;
end $$;

create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typnamespace = 'public'::regnamespace
      and typname = 'app_user_role'
  ) then
    create type public.app_user_role as enum (
      'Admin',
      'Lead',
      'Device Coordinator',
      'Shipper',
      'Device Systems Specialist'
    );
  end if;
end;
$$;

create table if not exists public.trial_files (
  id uuid primary key default gen_random_uuid(),
  last_name text not null,
  first_name text not null,
  device text not null,
  device_number text not null default '',
  gipod_code text not null default '',
  camera_number text not null default '',
  camera_number_2 text not null default '',
  camera_number_3 text not null default '',
  camera_number_4 text not null default '',
  loan_type text not null default '',
  queue_date date,
  expiration_date date,
  vocabulary text not null default '',
  notes text not null default '',
  priority text not null default 'Normal',
  status text not null default 'Ready for Pre-Prep',
  lane text not null default 'Daily Queue',
  crm_link text not null default '',
  prepper text not null default '',
  prepped_by text not null default '',
  qa_by text not null default '',
  prepped_by_user_id uuid references public.app_users(id),
  qa_by_user_id uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gipod_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  used_on text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  role public.app_user_role not null default 'Device Systems Specialist',
  permissions jsonb not null default '{}'::jsonb,
  weekly_schedule jsonb not null default '{}'::jsonb,
  trained_devices jsonb not null default '[]'::jsonb,
  pin_hash text not null,
  pin_lookup text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists app_users_name_unique
on public.app_users (lower(first_name), lower(last_name));

create table if not exists public.app_user_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  file_id uuid not null references public.trial_files(id) on delete cascade,
  action text not null check (action in ('prep_completed', 'qa_completed')),
  activity_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists public.app_shipment_activity (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null,
  first_name text not null default '',
  last_name text not null default '',
  loan_type text not null default '',
  device text not null default '',
  lane text not null default '',
  shipped_by_user_id uuid references public.app_users(id) on delete set null,
  shipped_date date not null default current_date,
  shipped_at timestamptz not null default now(),
  unique (file_id)
);

create table if not exists public.app_eod_cleanups (
  id uuid primary key default gen_random_uuid(),
  cleanup_date date not null default current_date,
  cleaned_by_user_id uuid references public.app_users(id) on delete set null,
  file_count integer not null default 0,
  loan_totals jsonb not null default '{}'::jsonb,
  device_totals jsonb not null default '{}'::jsonb,
  accessory_totals jsonb not null default '{}'::jsonb,
  files jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.coordinator_auto_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  entered_at timestamptz not null default now(),
  unique (user_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.claim_next_gipod_code(p_file_id uuid, p_crm_number text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  claimed_code text;
begin
  update public.gipod_codes
  set used_on = p_crm_number,
      note = coalesce(note, '')
  where id = (
    select id
    from public.gipod_codes
    where used_on = ''
    order by created_at, code
    limit 1
    for update skip locked
  )
  returning code into claimed_code;

  if claimed_code is null then
    return null;
  end if;

  update public.trial_files
  set gipod_code = claimed_code
  where id = p_file_id
    and gipod_code = '';

  if not found then
    update public.gipod_codes
    set used_on = '',
        note = ''
    where code = claimed_code;
    return null;
  end if;

  return claimed_code;
end;
$$;

drop trigger if exists set_trial_files_updated_at on public.trial_files;
create trigger set_trial_files_updated_at
before update on public.trial_files
for each row execute function public.set_updated_at();

drop trigger if exists set_gipod_codes_updated_at on public.gipod_codes;
create trigger set_gipod_codes_updated_at
before update on public.gipod_codes
for each row execute function public.set_updated_at();

drop trigger if exists set_app_users_updated_at on public.app_users;
create trigger set_app_users_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

create or replace function public.register_app_user(p_first_name text, p_last_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_user public.app_users;
begin
  if length(trim(p_first_name)) = 0 or length(trim(p_last_name)) = 0 then
    raise exception 'First and last name are required.';
  end if;

  if p_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits.';
  end if;

  insert into public.app_users (first_name, last_name, pin_hash, pin_lookup)
  values (
    initcap(trim(p_first_name)),
    initcap(trim(p_last_name)),
    extensions.crypt(p_pin, extensions.gen_salt('bf')),
    pg_catalog.encode(extensions.digest(p_pin, 'sha256'), 'hex')
  )
  returning * into created_user;

  return jsonb_build_object(
    'id', created_user.id,
    'firstName', created_user.first_name,
    'lastName', created_user.last_name,
    'role', created_user.role,
    'permissions', created_user.permissions
  );
exception
  when unique_violation then
    raise exception 'A user with that name or PIN already exists.';
end;
$$;

create or replace function public.login_app_user(p_first_name text, p_last_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_user public.app_users;
begin
  if p_pin !~ '^\d{4}$' then
    return null;
  end if;

  select *
  into matched_user
  from public.app_users
  where lower(first_name) = lower(trim(p_first_name))
    and lower(last_name) = lower(trim(p_last_name))
    and is_active = true
  limit 1;

  if matched_user.id is null then
    return null;
  end if;

  if matched_user.pin_hash <> extensions.crypt(p_pin, matched_user.pin_hash) then
    return null;
  end if;

  return jsonb_build_object(
    'id', matched_user.id,
    'firstName', matched_user.first_name,
    'lastName', matched_user.last_name,
    'role', matched_user.role,
    'permissions', matched_user.permissions
  );
end;
$$;

drop function if exists public.list_app_users(uuid);
create or replace function public.list_app_users(p_actor_id uuid)
returns table (
  id uuid,
  first_name text,
  last_name text,
  role public.app_user_role,
  permissions jsonb,
  weekly_schedule jsonb,
  trained_devices jsonb,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.app_users
    where app_users.id = p_actor_id
      and app_users.role in ('Admin', 'Lead')
      and app_users.is_active = true
  ) then
    raise exception 'Only Admin and Lead users can manage users.';
  end if;

  return query
  select
    app_users.id,
    app_users.first_name,
    app_users.last_name,
    app_users.role,
    app_users.permissions,
    app_users.weekly_schedule,
    app_users.trained_devices,
    app_users.is_active,
    app_users.created_at,
    app_users.updated_at
  from public.app_users
  order by app_users.last_name, app_users.first_name;
end;
$$;

create or replace function public.create_app_user(
  p_actor_id uuid,
  p_first_name text,
  p_last_name text,
  p_pin text,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_user public.app_users;
begin
  if not exists (
    select 1
    from public.app_users
    where app_users.id = p_actor_id
      and app_users.role in ('Admin', 'Lead')
      and app_users.is_active = true
  ) then
    raise exception 'Only Admin and Lead users can create users.';
  end if;

  if length(trim(p_first_name)) = 0 or length(trim(p_last_name)) = 0 then
    raise exception 'First and last name are required.';
  end if;

  if p_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits.';
  end if;

  if p_role not in ('Admin', 'Lead', 'Device Coordinator', 'Shipper', 'Device Systems Specialist') then
    raise exception 'Invalid role.';
  end if;

  insert into public.app_users (first_name, last_name, role, pin_hash, pin_lookup)
  values (
    initcap(trim(p_first_name)),
    initcap(trim(p_last_name)),
    p_role::public.app_user_role,
    extensions.crypt(p_pin, extensions.gen_salt('bf')),
    pg_catalog.encode(extensions.digest(p_pin, 'sha256'), 'hex')
  )
  returning * into created_user;

  return jsonb_build_object(
    'id', created_user.id,
    'firstName', created_user.first_name,
    'lastName', created_user.last_name,
    'role', created_user.role,
    'permissions', created_user.permissions
  );
exception
  when unique_violation then
    raise exception 'A user with that name or PIN already exists.';
end;
$$;

create or replace function public.delete_app_user(p_actor_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.app_users
    where app_users.id = p_actor_id
      and app_users.role in ('Admin', 'Lead')
      and app_users.is_active = true
  ) then
    raise exception 'Only Admin and Lead users can remove users.';
  end if;

  if p_actor_id = p_user_id then
    raise exception 'You cannot remove your own user while logged in.';
  end if;

  delete from public.app_users
  where app_users.id = p_user_id;
end;
$$;

create or replace function public.list_device_specialists()
returns table (
  id uuid,
  first_name text,
  last_name text,
  trained_devices jsonb
)
language sql
security definer
set search_path = ''
as $$
  select app_users.id, app_users.first_name, app_users.last_name, app_users.trained_devices
  from public.app_users
  where app_users.role = 'Device Systems Specialist'
    and app_users.is_active = true
  order by app_users.last_name, app_users.first_name;
$$;

drop function if exists public.list_device_coordinators();
create or replace function public.list_device_coordinators()
returns table (
  id uuid,
  first_name text,
  last_name text
)
language sql
security definer
set search_path = ''
as $$
  select app_users.id, app_users.first_name, app_users.last_name
  from public.app_users
  where app_users.role = 'Device Coordinator'
    and app_users.is_active = true
  order by app_users.last_name, app_users.first_name;
$$;

create or replace function public.get_app_user_profile(p_actor_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.app_user_role;
  target_user public.app_users;
begin
  select role into actor_role
  from public.app_users
  where id = p_actor_id
    and is_active = true;

  if p_actor_id <> p_user_id and actor_role not in ('Admin', 'Lead') then
    raise exception 'Only Admin, Lead, or the profile owner can view this profile.';
  end if;

  select * into target_user
  from public.app_users
  where id = p_user_id
    and is_active = true;

  if target_user.id is null then
    raise exception 'User not found.';
  end if;

  return jsonb_build_object(
    'id', target_user.id,
    'firstName', target_user.first_name,
    'lastName', target_user.last_name,
    'role', target_user.role,
    'permissions', target_user.permissions,
    'weeklySchedule', target_user.weekly_schedule,
    'trainedDevices', target_user.trained_devices
  );
end;
$$;

create or replace function public.update_own_app_user_pin(p_user_id uuid, p_current_pin text, p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user public.app_users;
begin
  if p_current_pin !~ '^\d{4}$' or p_new_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits.';
  end if;

  select * into target_user
  from public.app_users
  where id = p_user_id
    and is_active = true;

  if target_user.id is null or target_user.pin_hash <> extensions.crypt(p_current_pin, target_user.pin_hash) then
    raise exception 'Current PIN is incorrect.';
  end if;

  update public.app_users
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
      pin_lookup = pg_catalog.encode(extensions.digest(p_new_pin, 'sha256'), 'hex')
  where app_users.id = p_user_id
  returning * into target_user;

  return jsonb_build_object(
    'id', target_user.id,
    'firstName', target_user.first_name,
    'lastName', target_user.last_name,
    'role', target_user.role,
    'permissions', target_user.permissions,
    'weeklySchedule', target_user.weekly_schedule,
    'trainedDevices', target_user.trained_devices
  );
exception
  when unique_violation then
    raise exception 'That PIN is already used by another user.';
end;
$$;

create or replace function public.update_app_user_schedule(p_actor_id uuid, p_user_id uuid, p_schedule jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.app_user_role;
  target_user public.app_users;
begin
  select role into actor_role
  from public.app_users
  where id = p_actor_id
    and is_active = true;

  if p_actor_id <> p_user_id and actor_role not in ('Admin', 'Lead') then
    raise exception 'Only Admin, Lead, or the profile owner can update this schedule.';
  end if;

  update public.app_users
  set weekly_schedule = coalesce(p_schedule, '{}'::jsonb)
  where app_users.id = p_user_id
  returning * into target_user;

  if target_user.id is null then
    raise exception 'User not found.';
  end if;

  return jsonb_build_object(
    'id', target_user.id,
    'firstName', target_user.first_name,
    'lastName', target_user.last_name,
    'role', target_user.role,
    'permissions', target_user.permissions,
    'weeklySchedule', target_user.weekly_schedule,
    'trainedDevices', target_user.trained_devices
  );
end;
$$;

create or replace function public.update_app_user_trained_devices(p_actor_id uuid, p_user_id uuid, p_trained_devices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.app_user_role;
  target_user public.app_users;
begin
  select role into actor_role
  from public.app_users
  where id = p_actor_id
    and is_active = true;

  if p_actor_id <> p_user_id and actor_role not in ('Admin', 'Lead') then
    raise exception 'Only Admin, Lead, or the profile owner can update trained devices.';
  end if;

  if jsonb_typeof(coalesce(p_trained_devices, '[]'::jsonb)) <> 'array' then
    raise exception 'Trained devices must be a list.';
  end if;

  update public.app_users
  set trained_devices = coalesce(p_trained_devices, '[]'::jsonb)
  where app_users.id = p_user_id
  returning * into target_user;

  if target_user.id is null then
    raise exception 'User not found.';
  end if;

  return jsonb_build_object(
    'id', target_user.id,
    'firstName', target_user.first_name,
    'lastName', target_user.last_name,
    'role', target_user.role,
    'permissions', target_user.permissions,
    'weeklySchedule', target_user.weekly_schedule,
    'trainedDevices', target_user.trained_devices
  );
end;
$$;

create or replace function public.list_app_user_activity(p_actor_id uuid, p_user_id uuid)
returns table (
  action text,
  activity_date date,
  count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.app_user_role;
begin
  select role into actor_role
  from public.app_users
  where id = p_actor_id
    and is_active = true;

  if p_actor_id <> p_user_id and actor_role not in ('Admin', 'Lead') then
    raise exception 'Only Admin, Lead, or the profile owner can view this activity.';
  end if;

  return query
  select app_user_activity.action, app_user_activity.activity_date, count(*)::bigint
  from public.app_user_activity
  where app_user_activity.user_id = p_user_id
  group by app_user_activity.action, app_user_activity.activity_date
  order by app_user_activity.activity_date desc, app_user_activity.action;
end;
$$;

create or replace function public.list_team_user_activity(p_actor_id uuid)
returns table (
  user_id uuid,
  first_name text,
  last_name text,
  role public.app_user_role,
  action text,
  activity_date date,
  count bigint,
  latest_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.app_users
    where app_users.id = p_actor_id
      and app_users.role in ('Admin', 'Lead')
      and app_users.is_active = true
  ) then
    raise exception 'Only Admin and Lead users can view team activity.';
  end if;

  return query
  select
    app_users.id,
    app_users.first_name,
    app_users.last_name,
    app_users.role,
    app_user_activity.action,
    app_user_activity.activity_date,
    count(*)::bigint,
    max(app_user_activity.created_at)
  from public.app_user_activity
  join public.app_users on app_users.id = app_user_activity.user_id
  group by app_users.id, app_users.first_name, app_users.last_name, app_users.role, app_user_activity.action, app_user_activity.activity_date
  order by app_user_activity.activity_date desc, app_users.last_name, app_users.first_name, app_user_activity.action;
end;
$$;

create or replace function public.update_app_user_role(p_actor_id uuid, p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_user public.app_users;
begin
  if p_role not in ('Admin', 'Lead', 'Device Coordinator', 'Shipper', 'Device Systems Specialist') then
    raise exception 'Invalid role.';
  end if;

  if not exists (
    select 1
    from public.app_users
    where app_users.id = p_actor_id
      and app_users.role in ('Admin', 'Lead')
      and app_users.is_active = true
  ) then
    raise exception 'Only Admin and Lead users can update user roles.';
  end if;

  update public.app_users
  set role = p_role::public.app_user_role
  where app_users.id = p_user_id
  returning * into changed_user;

  if changed_user.id is null then
    raise exception 'User not found.';
  end if;

  return jsonb_build_object(
    'id', changed_user.id,
    'firstName', changed_user.first_name,
    'lastName', changed_user.last_name,
    'role', changed_user.role,
    'permissions', changed_user.permissions
  );
end;
$$;

create or replace function public.update_app_user_pin(p_actor_id uuid, p_user_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_user public.app_users;
begin
  if p_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits.';
  end if;

  if not exists (
    select 1
    from public.app_users
    where app_users.id = p_actor_id
      and app_users.role in ('Admin', 'Lead')
      and app_users.is_active = true
  ) then
    raise exception 'Only Admin and Lead users can reset PINs.';
  end if;

  update public.app_users
  set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')),
      pin_lookup = pg_catalog.encode(extensions.digest(p_pin, 'sha256'), 'hex')
  where app_users.id = p_user_id
  returning * into changed_user;

  if changed_user.id is null then
    raise exception 'User not found.';
  end if;

  return jsonb_build_object(
    'id', changed_user.id,
    'firstName', changed_user.first_name,
    'lastName', changed_user.last_name,
    'role', changed_user.role,
    'permissions', changed_user.permissions
  );
exception
  when unique_violation then
    raise exception 'That PIN is already used by another user.';
end;
$$;

alter table public.trial_files enable row level security;
alter table public.gipod_codes enable row level security;
alter table public.app_users enable row level security;
alter table public.app_user_activity enable row level security;
alter table public.app_shipment_activity enable row level security;
alter table public.app_eod_cleanups enable row level security;
alter table public.coordinator_auto_queue enable row level security;

drop policy if exists "Team can read trial files" on public.trial_files;
create policy "Team can read trial files"
on public.trial_files for select
to anon, authenticated
using (true);

drop policy if exists "Team can insert trial files" on public.trial_files;
create policy "Team can insert trial files"
on public.trial_files for insert
to anon, authenticated
with check (true);

drop policy if exists "Team can update trial files" on public.trial_files;
create policy "Team can update trial files"
on public.trial_files for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "Team can delete trial files" on public.trial_files;
create policy "Team can delete trial files"
on public.trial_files for delete
to anon, authenticated
using (true);

drop policy if exists "Team can read gipod codes" on public.gipod_codes;
create policy "Team can read gipod codes"
on public.gipod_codes for select
to anon, authenticated
using (true);

drop policy if exists "Team can insert gipod codes" on public.gipod_codes;
create policy "Team can insert gipod codes"
on public.gipod_codes for insert
to anon, authenticated
with check (true);

drop policy if exists "Team can update gipod codes" on public.gipod_codes;
create policy "Team can update gipod codes"
on public.gipod_codes for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "Team can delete gipod codes" on public.gipod_codes;
create policy "Team can delete gipod codes"
on public.gipod_codes for delete
to anon, authenticated
using (true);

drop policy if exists "Team can insert activity" on public.app_user_activity;
create policy "Team can insert activity"
on public.app_user_activity for insert
to anon, authenticated
with check (true);

drop policy if exists "Team can read activity through app" on public.app_user_activity;
create policy "Team can read activity through app"
on public.app_user_activity for select
to anon, authenticated
using (true);

drop policy if exists "Team can read shipment activity" on public.app_shipment_activity;
create policy "Team can read shipment activity"
on public.app_shipment_activity for select
to anon, authenticated
using (true);

drop policy if exists "Team can insert shipment activity" on public.app_shipment_activity;
create policy "Team can insert shipment activity"
on public.app_shipment_activity for insert
to anon, authenticated
with check (true);

drop policy if exists "Team can delete shipment activity" on public.app_shipment_activity;
create policy "Team can delete shipment activity"
on public.app_shipment_activity for delete
to anon, authenticated
using (true);

drop policy if exists "Team can read eod cleanups" on public.app_eod_cleanups;
create policy "Team can read eod cleanups"
on public.app_eod_cleanups for select
to anon, authenticated
using (true);

drop policy if exists "Team can insert eod cleanups" on public.app_eod_cleanups;
create policy "Team can insert eod cleanups"
on public.app_eod_cleanups for insert
to anon, authenticated
with check (true);

drop policy if exists "Team can delete eod cleanups" on public.app_eod_cleanups;
create policy "Team can delete eod cleanups"
on public.app_eod_cleanups for delete
to anon, authenticated
using (true);

drop policy if exists "Team can read coordinator queue" on public.coordinator_auto_queue;
create policy "Team can read coordinator queue"
on public.coordinator_auto_queue for select
to anon, authenticated
using (true);

drop policy if exists "Team can insert coordinator queue" on public.coordinator_auto_queue;
create policy "Team can insert coordinator queue"
on public.coordinator_auto_queue for insert
to anon, authenticated
with check (true);

drop policy if exists "Team can delete coordinator queue" on public.coordinator_auto_queue;
create policy "Team can delete coordinator queue"
on public.coordinator_auto_queue for delete
to anon, authenticated
using (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.trial_files to anon, authenticated;
grant select, insert, update, delete on public.gipod_codes to anon, authenticated;
revoke all on public.app_users from anon, authenticated;
grant select, insert on public.app_user_activity to anon, authenticated;
grant select, insert, delete on public.app_shipment_activity to anon, authenticated;
grant select, insert, delete on public.app_eod_cleanups to anon, authenticated;
grant select, insert, delete on public.coordinator_auto_queue to anon, authenticated;
grant execute on function public.claim_next_gipod_code(uuid, text) to anon, authenticated;
grant execute on function public.register_app_user(text, text, text) to anon, authenticated;
grant execute on function public.login_app_user(text, text, text) to anon, authenticated;
grant execute on function public.list_app_users(uuid) to anon, authenticated;
grant execute on function public.create_app_user(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_app_user(uuid, uuid) to anon, authenticated;
grant execute on function public.list_device_specialists() to anon, authenticated;
grant execute on function public.list_device_coordinators() to anon, authenticated;
grant execute on function public.get_app_user_profile(uuid, uuid) to anon, authenticated;
grant execute on function public.update_own_app_user_pin(uuid, text, text) to anon, authenticated;
grant execute on function public.update_app_user_schedule(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.update_app_user_trained_devices(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.list_app_user_activity(uuid, uuid) to anon, authenticated;
grant execute on function public.list_team_user_activity(uuid) to anon, authenticated;
grant execute on function public.update_app_user_role(uuid, uuid, text) to anon, authenticated;
grant execute on function public.update_app_user_pin(uuid, uuid, text) to anon, authenticated;

alter table public.trial_files replica identity full;
alter table public.gipod_codes replica identity full;
alter table public.coordinator_auto_queue replica identity full;
alter table public.app_shipment_activity replica identity full;
alter table public.app_eod_cleanups replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'trial_files'
    ) then
      alter publication supabase_realtime add table public.trial_files;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'gipod_codes'
    ) then
      alter publication supabase_realtime add table public.gipod_codes;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'coordinator_auto_queue'
    ) then
      alter publication supabase_realtime add table public.coordinator_auto_queue;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'app_shipment_activity'
    ) then
      alter publication supabase_realtime add table public.app_shipment_activity;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'app_eod_cleanups'
    ) then
      alter publication supabase_realtime add table public.app_eod_cleanups;
    end if;
  end if;
end;
$$;

insert into public.app_users (first_name, last_name, role, pin_hash, pin_lookup)
select
  'Smartbox',
  'Admin',
  'Admin',
  extensions.crypt('7394', extensions.gen_salt('bf')),
  pg_catalog.encode(extensions.digest('7394', 'sha256'), 'hex')
where not exists (
  select 1
  from public.app_users
  where lower(first_name) = 'smartbox'
    and lower(last_name) = 'admin'
);

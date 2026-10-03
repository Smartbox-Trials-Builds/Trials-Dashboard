-- Apply after schema.sql. Queue writes require a valid PIN session.
create schema if not exists app_private;
revoke all on schema app_private from public;
create table if not exists app_private.device_assignment_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  file_id uuid,
  client_name text not null,
  device text not null,
  job text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
alter table app_private.device_assignment_notices enable row level security;
revoke insert, delete on public.coordinator_auto_queue from anon, authenticated;
create index if not exists coordinator_fifo_idx on public.coordinator_auto_queue(entered_at, id);

create or replace function app_private.queue_actor(token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid;
begin
  select s.user_id into actor from public.app_device_request_sessions s
  join public.app_users u on u.id=s.user_id
  where s.token_hash=pg_catalog.encode(extensions.digest(coalesce(token,''),'sha256'),'hex')
    and s.expires_at>now() and s.revoked_at is null and u.is_active;
  if actor is null then raise exception 'Please sign in again.'; end if;
  return actor;
end $$;

create or replace function app_private.assign_device_queue() returns void
language plpgsql security definer set search_path = '' as $$
declare f public.trial_files; q record; initials text; job text;
begin
  if current_setting('app.queue_running',true)='yes' then return; end if;
  perform pg_advisory_xact_lock(728194);
  perform set_config('app.queue_running','yes',true);
  -- Manual claims remove the coordinator from the waiting queue too.
  delete from public.coordinator_auto_queue x where exists (
    select 1 from public.trial_files t where
      (t.status like 'Being prepped by %' and t.prepped_by_user_id=x.user_id)
      or (t.status like 'Being QA''d by %' and t.qa_by_user_id=x.user_id));
  for f in select * from public.trial_files
    where (status='Ready for Prep' and prepped_by_user_id is null and prepped_by='')
       or (status='Ready for QA' and qa_by_user_id is null and qa_by='')
    order by case when upper(priority)='EXPEDITE' or lane='Expedites' then 0 else 1 end,
      created_at,id for update
  loop
    select x.id, x.user_id, u.first_name,u.last_name into q
    from public.coordinator_auto_queue x join public.app_users u on u.id=x.user_id
    where u.is_active and u.role='Device Coordinator'
      and (f.status<>'Ready for QA' or (u.id is distinct from f.prepped_by_user_id
        and upper(left(u.first_name,1)||left(u.last_name,1))<>upper(f.prepped_by)))
      and exists (select 1 from jsonb_array_elements_text(u.trained_devices) d(value)
        where regexp_replace(regexp_replace(lower(d.value),'[^a-z0-9]','','g'),'s$','')<>''
        and (position(regexp_replace(regexp_replace(lower(d.value),'[^a-z0-9]','','g'),'s$','')
          in regexp_replace(regexp_replace(lower(f.device),'[^a-z0-9]','','g'),'s$',''))>0))
    order by x.entered_at,x.id limit 1 for update of x;
    if not found then continue; end if;
    initials:=upper(left(q.first_name,1)||left(q.last_name,1));
    job:=case when f.status='Ready for Prep' then 'Prep' else 'QA' end;
    if job='Prep' then
      update public.trial_files set status='Being prepped by '||initials,
        prepped_by=initials,prepped_by_user_id=q.user_id where id=f.id;
    else
      update public.trial_files set status='Being QA''d by '||initials,
        qa_by=initials,qa_by_user_id=q.user_id where id=f.id;
    end if;
    delete from public.coordinator_auto_queue where id=q.id;
    insert into app_private.device_assignment_notices(user_id,file_id,client_name,device,job)
      values(q.user_id,f.id,f.last_name||', '||f.first_name,f.device,job);
    insert into public.app_file_logs(file_id,actor_user_id,actor_name,action,field_name,old_value,new_value)
      values(f.id,q.user_id,q.first_name||' '||q.last_name,'Automatic queue assignment','Assignment',f.status,job||': '||q.first_name||' '||q.last_name);
  end loop;
  perform set_config('app.queue_running','no',true);
end $$;

create or replace function public.device_queue_action(p_session_token text,p_action text,p_notice_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin return app_private.device_queue_action(p_session_token,p_action,p_notice_id); end $$;

create or replace function app_private.device_queue_action(p_session_token text,p_action text,p_notice_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; result jsonb;
begin
  actor:=app_private.queue_actor(p_session_token);
  perform pg_advisory_xact_lock(728194);
  if p_action='enter' then
    if not exists(select 1 from public.app_users where id=actor and role='Device Coordinator') then
      raise exception 'Only Device Coordinators can enter the queue.'; end if;
    if exists(select 1 from public.trial_files where
      (status like 'Being prepped by %' and prepped_by_user_id=actor)
      or (status like 'Being QA''d by %' and qa_by_user_id=actor)) then
      raise exception 'Finish your assigned work before entering the queue.'; end if;
    if not exists(select 1 from public.app_users where id=actor and jsonb_array_length(trained_devices)>0) then
      raise exception 'Select your trained devices in your profile first.'; end if;
    insert into public.coordinator_auto_queue(user_id) values(actor) on conflict(user_id) do nothing;
    perform app_private.assign_device_queue();
  elsif p_action='leave' then
    delete from public.coordinator_auto_queue where user_id=actor;
  elsif p_action='close' then
    update app_private.device_assignment_notices set closed_at=now() where id=p_notice_id and user_id=actor;
  elsif p_action<>'read' then raise exception 'Unknown queue action.';
  end if;
  select jsonb_build_object('queue',coalesce((select jsonb_agg(row_to_json(r)) from
    (select x.id,x.user_id,x.entered_at,u.first_name||' '||u.last_name as name
      from public.coordinator_auto_queue x join public.app_users u on u.id=x.user_id
      order by x.entered_at,x.id) r),'[]'::jsonb),
    'notices',coalesce((select jsonb_agg(n order by n.created_at,n.id)
      from app_private.device_assignment_notices n where user_id=actor and closed_at is null),'[]'::jsonb)) into result;
  return result;
end $$;
grant usage on schema app_private to anon,authenticated;
revoke all on all functions in schema app_private from public;
grant execute on function app_private.device_queue_action(text,text,uuid) to anon,authenticated;
revoke all on function public.device_queue_action(text,text,uuid) from public;
grant execute on function public.device_queue_action(text,text,uuid) to anon,authenticated;

create or replace function app_private.queue_lock() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform pg_advisory_xact_lock(728194); return null; end $$;
create or replace function app_private.queue_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform app_private.assign_device_queue(); return null; end $$;
drop trigger if exists device_queue_lock on public.trial_files;
create trigger device_queue_lock before insert or update or delete on public.trial_files
for each statement execute function app_private.queue_lock();
drop trigger if exists device_queue_changed on public.trial_files;
create trigger device_queue_changed after insert or update or delete on public.trial_files
for each statement execute function app_private.queue_changed();
drop trigger if exists device_training_queue_lock on public.app_users;
create trigger device_training_queue_lock before update on public.app_users
for each statement execute function app_private.queue_lock();
drop trigger if exists device_training_queue_changed on public.app_users;
create trigger device_training_queue_changed after update on public.app_users
for each statement execute function app_private.queue_changed();

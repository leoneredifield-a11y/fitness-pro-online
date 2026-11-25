begin;

alter table public.profiles add column training_access text not null default 'both'
  check (training_access in ('female', 'male', 'both'));

insert into public.profiles (id, full_name)
select id, raw_user_meta_data ->> 'full_name' from auth.users
on conflict (id) do nothing;

revoke insert, update on public.profiles from public, anon, authenticated;
grant select, update (full_name, birth_date, sex) on public.profiles to authenticated;
grant select on public.profiles to service_role;
revoke all on public.user_roles from public, anon, authenticated;
grant select on public.user_roles to authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, training_access)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case new.raw_user_meta_data ->> 'training_access'
      when 'female' then 'female'
      when 'male' then 'male'
      else 'both'
    end)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'member') on conflict do nothing;

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active');

  insert into public.user_goals (user_id)
  values (new.id) on conflict (user_id) do nothing;

  return new;
end;
$$;

create table public.fitness_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null check (
    jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 8388608
  ),
  updated_at timestamptz not null default now()
);

alter table public.fitness_state enable row level security;
revoke all on public.fitness_state from public, anon, authenticated;
grant select on public.fitness_state to authenticated, service_role;
create policy fitness_state_read_own on public.fitness_state
  for select to authenticated using (user_id = (select auth.uid()));

create function public.save_fitness_state(expected_user_id uuid, expected_revision integer, new_snapshot jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  saved_revision integer;
begin
  if account_id is null or account_id is distinct from expected_user_id then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception 'Revisão inválida' using errcode = '22023';
  end if;

  if expected_revision = 0 then
    insert into public.fitness_state (user_id, revision, snapshot)
    values (account_id, 1, new_snapshot)
    on conflict (user_id) do nothing
    returning revision into saved_revision;
  else
    update public.fitness_state
    set revision = revision + 1, snapshot = new_snapshot, updated_at = now()
    where user_id = account_id and revision = expected_revision
    returning revision into saved_revision;
  end if;

  return saved_revision;
end;
$$;

revoke all on function public.save_fitness_state(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_fitness_state(uuid, integer, jsonb) to authenticated;

commit;

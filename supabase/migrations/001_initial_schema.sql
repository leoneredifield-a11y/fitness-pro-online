-- Fitness Pro | Initial database schema
-- PostgreSQL + Supabase Auth + Row Level Security
create extension if not exists pgcrypto;

create type public.app_role as enum ('owner', 'admin', 'support', 'member');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'expired');
create type public.subscription_plan as enum ('free', 'premium', 'pro');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  birth_date date,
  sex text check (sex in ('female','male','other','prefer_not_to_say')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Roles are never writable by ordinary clients. Assign owner/admin roles manually
-- from the Supabase SQL editor or a trusted server-side administrative process.
create table public.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan public.subscription_plan not null default 'free',
  status public.subscription_status not null default 'trialing',
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create table public.workout_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null check (category in ('male','female','custom')),
  description text,
  is_template boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workout_exercises (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.workout_plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table public.workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references public.workout_plans(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table public.workout_sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.workout_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_name text not null,
  set_number integer not null check (set_number > 0),
  reps integer check (reps is null or reps >= 0),
  weight_kg numeric(7,2) check (weight_kg is null or weight_kg >= 0),
  rest_seconds integer check (rest_seconds is null or rest_seconds >= 0),
  created_at timestamptz not null default now()
);

create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  eaten_at timestamptz not null default now(),
  meal_type text,
  description text not null,
  calories integer check (calories is null or calories >= 0),
  protein_g numeric(7,2) check (protein_g is null or protein_g >= 0),
  carbs_g numeric(7,2) check (carbs_g is null or carbs_g >= 0),
  fat_g numeric(7,2) check (fat_g is null or fat_g >= 0),
  created_at timestamptz not null default now()
);

create table public.water_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_ml integer not null check (amount_ml between 1 and 5000),
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.user_goals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_water_goal_ml integer not null default 2500 check (daily_water_goal_ml between 250 and 10000),
  daily_calorie_goal integer check (daily_calorie_goal is null or daily_calorie_goal between 500 and 10000),
  updated_at timestamptz not null default now()
);

create table public.body_measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  measured_at timestamptz not null default now(),
  weight_kg numeric(6,2) check (weight_kg is null or weight_kg between 20 and 500),
  body_fat_percent numeric(5,2) check (body_fat_percent is null or body_fat_percent between 1 and 75),
  waist_cm numeric(6,2),
  hip_cm numeric(6,2),
  notes text,
  created_at timestamptz not null default now()
);

-- Private storage bucket for progress images. Access is scoped to the user's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('progress-photos', 'progress-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create or replace function public.has_staff_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role in ('owner','admin','support')
  );
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'owner'
  );
$$;

grant execute on function public.has_staff_access() to authenticated;
grant execute on function public.is_owner() to authenticated;

-- Enable RLS on all application tables.
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.workout_plans enable row level security;
alter table public.workout_exercises enable row level security;
alter table public.workout_sessions enable row level security;
alter table public.workout_sets enable row level security;
alter table public.meals enable row level security;
alter table public.water_logs enable row level security;
alter table public.user_goals enable row level security;
alter table public.body_measurements enable row level security;

-- Profiles: users can read/update their own profile; staff can read for support.
create policy "profile_select_own_or_staff" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or public.has_staff_access());
create policy "profile_insert_self" on public.profiles
for insert to authenticated
with check (id = (select auth.uid()));
create policy "profile_update_self" on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Role records are readable only by the account owner; no client-side role writes.
create policy "roles_read_self_or_owner" on public.user_roles
for select to authenticated
using (user_id = (select auth.uid()) or public.is_owner());

-- Subscriptions: users can see their own status; staff can inspect. Writes are server-only.
create policy "subscriptions_read_self_or_staff" on public.subscriptions
for select to authenticated
using (user_id = (select auth.uid()) or public.has_staff_access());

-- User-owned content: own records only. Staff access is intentionally not granted
-- to private fitness/health-related records by default.
create policy "workout_plans_own" on public.workout_plans
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "workout_exercises_own" on public.workout_exercises
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "workout_sessions_own" on public.workout_sessions
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "workout_sets_own" on public.workout_sets
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "meals_own" on public.meals
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "water_logs_own" on public.water_logs
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "user_goals_own" on public.user_goals
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "body_measurements_own" on public.body_measurements
for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Storage policies: private per-user directory, first path segment must be auth.uid().
create policy "progress_photos_read_own" on storage.objects
for select to authenticated
using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "progress_photos_insert_own" on storage.objects
for insert to authenticated
with check (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "progress_photos_delete_own" on storage.objects
for delete to authenticated
using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Useful indexes for per-user timelines.
create index if not exists water_logs_user_logged_at_idx on public.water_logs(user_id, logged_at desc);
create index if not exists meals_user_eaten_at_idx on public.meals(user_id, eaten_at desc);
create index if not exists workout_sessions_user_started_at_idx on public.workout_sessions(user_id, started_at desc);
create index if not exists body_measurements_user_measured_at_idx on public.body_measurements(user_id, measured_at desc);

-- Create a member profile and a free subscription after a new Auth account is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'member')
  on conflict do nothing;

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active');

  insert into public.user_goals (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- IMPORTANT: After creating your own account, assign owner role manually in SQL Editor:
-- insert into public.user_roles (user_id, role)
-- select id, 'owner'::public.app_role from auth.users where email = 'YOUR_ADMIN_EMAIL';

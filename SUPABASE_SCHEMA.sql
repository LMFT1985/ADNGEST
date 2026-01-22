-- Supabase (Postgres) schema suggestion for ADNGest
-- Run in Supabase SQL editor.

create table if not exists public.devices (
  id text primary key,
  type text not null, -- 'datalogger' | 'caudalimetro'
  name text not null,
  lat double precision,
  lng double precision,
  municipio text,
  source_type text default 'manual',
  external_id text,
  scada_url text,
  collector_url text,
  created_at timestamptz default now()
);

create table if not exists public.telemetry (
  id bigserial primary key,
  device_id text references public.devices(id) on delete cascade,
  device_type text,
  ts timestamptz not null,
  level_pct numeric,
  flow_m3 numeric,
  raw jsonb,
  created_at timestamptz default now()
);

create index if not exists telemetry_device_ts_idx on public.telemetry(device_id, ts desc);

-- Hourly meteorology history (precipitation + optional temperature) per locality
create table if not exists public.meteo_hourly (
  id bigserial primary key,
  loc_key text not null, -- e.g. 'Guimarães' (PT)
  ts timestamptz not null,
  precipitation_mm numeric,
  temp_c numeric,
  lat double precision,
  lng double precision,
  name text,
  created_at timestamptz default now()
);

create index if not exists meteo_hourly_loc_ts_idx on public.meteo_hourly(loc_key, ts desc);

-- Alert rules
create table if not exists public.alert_rules (
  id bigserial primary key,
  user_email text,
  device_id text,
  metric text not null, -- 'level' | 'flow' | 'rain'
  op text not null,     -- '>=', '>', '<=', '<'
  threshold numeric not null,
  is_enabled boolean default true,
  created_at timestamptz default now()
);

-- User roles
create table if not exists public.user_roles (
  email text primary key,
  role text not null, -- 'admin' | 'operator' | 'viewer'
  created_at timestamptz default now()
);

-- API keys for external ingestion (store hashed if used in production)
create table if not exists public.api_keys (
  id bigserial primary key,
  api_key text not null,
  created_by text,
  created_at timestamptz default now(),
  is_revoked boolean default false
);

create index if not exists api_keys_active_idx on public.api_keys(is_revoked, created_at desc);

-- Audit log (Histórico Utilizadores)
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null,
  "user" text not null,
  action text not null,
  detail text,
  meta jsonb
);

create index if not exists audit_log_ts_idx on public.audit_log(ts desc);

-- NOTE (demo mode): allow anon key to read/write without configuring RLS policies.
-- If you prefer to use RLS, remove the lines below and create explicit policies.
alter table public.devices disable row level security;
alter table public.telemetry disable row level security;
alter table public.meteo_hourly disable row level security;
alter table public.alert_rules disable row level security;
alter table public.user_roles disable row level security;
alter table public.api_keys disable row level security;
alter table public.audit_log disable row level security;

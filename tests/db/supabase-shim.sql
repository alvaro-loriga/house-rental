-- Minimal stand-in for the parts of a Supabase database that the migrations rely on:
-- the auth schema, auth.uid()/auth.jwt(), the API roles and Supabase's permissive default
-- privileges (so the tests prove that the migrations lock things down themselves).
-- Used only by the local test database and the local development backend.
create schema if not exists auth;
create schema if not exists extensions;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login password 'authenticator' noinherit;
grant anon, authenticated, service_role to authenticator;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz default now(),
  created_at timestamptz not null default now()
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter database postgres set search_path to "$user", public, extensions;
set search_path to "$user", public, extensions;

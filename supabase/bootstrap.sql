-- PRODUCTION BOOTSTRAP - run once, as the database owner (Supabase SQL editor), after the
-- migrations and after creating the first user in Authentication > Users.
--
-- It creates the private family workspace, the first property ("Casa Salobreña", editable
-- later in the app) and makes one existing, confirmed user its administrator. No fictitious
-- data is inserted. Everyone else is invited afterwards from Settings inside the app.
--
-- Edit the three values below before running.

do $$
declare
  v_admin_email text := 'CHANGE-ME@example.com';   -- e-mail of the first administrator
  v_workspace_name text := 'Familia';              -- shown in the top bar
  v_property_name text := 'Casa Salobreña';        -- first property; rename it in the app any time
  v_user uuid;
  v_workspace uuid;
begin
  if exists (select 1 from public.workspaces) then
    raise exception 'A workspace already exists. Nothing was changed.';
  end if;
  select id into v_user from auth.users
   where lower(email) = lower(v_admin_email) and email_confirmed_at is not null;
  if v_user is null then
    raise exception 'No confirmed user with e-mail % exists. Create the user first (Authentication > Users).', v_admin_email;
  end if;

  insert into public.workspaces (name) values (v_workspace_name) returning id into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_workspace, v_user, 'admin');
  insert into public.properties (workspace_id, name, timezone) values (v_workspace, v_property_name, 'Europe/Madrid');
  raise notice 'Workspace % created with administrator %', v_workspace_name, v_admin_email;
end $$;

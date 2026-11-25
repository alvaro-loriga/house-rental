-- Rental manager: row level security, table grants and function grants.
--
-- Model
--   * anon has no access to anything.
--   * authenticated users see only rows of workspaces they are a member of.
--   * Guests, properties, periods and candidates may be written directly (under RLS).
--   * Holds, bookings, allocations, payments, instalments, memberships and every audit table
--     are read-only for clients; they change exclusively through the RPCs.

do $$
declare
  t text;
begin
  foreach t in array array[
    'workspaces', 'workspace_members', 'workspace_invitations', 'user_preferences', 'properties', 'guests',
    'booking_periods', 'booking_candidates', 'bookings', 'booking_events', 'temporary_holds', 'hold_events',
    'availability_allocations', 'payment_installments', 'payments', 'payment_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

grant insert, update on table public.guests, public.properties, public.booking_periods, public.booking_candidates
  to authenticated;
grant insert, update on table public.user_preferences to authenticated;

-- Workspaces and membership -------------------------------------------------
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));

create policy workspace_members_select on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy workspace_invitations_select on public.workspace_invitations for select to authenticated
  using (public.is_workspace_admin(workspace_id));

create policy user_preferences_select on public.user_preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_preferences_insert on public.user_preferences for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_preferences_update on public.user_preferences for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Directly writable business tables -----------------------------------------
create policy properties_select on public.properties for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy properties_insert on public.properties for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));
create policy properties_update on public.properties for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy guests_select on public.guests for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy guests_insert on public.guests for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy guests_update on public.guests for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy booking_periods_select on public.booking_periods for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy booking_periods_insert on public.booking_periods for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy booking_periods_update on public.booking_periods for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy booking_candidates_select on public.booking_candidates for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy booking_candidates_insert on public.booking_candidates for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy booking_candidates_update on public.booking_candidates for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

-- Read-only (RPC-managed) tables ---------------------------------------------
create policy bookings_select on public.bookings for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy booking_events_select on public.booking_events for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy temporary_holds_select on public.temporary_holds for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy hold_events_select on public.hold_events for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy availability_allocations_select on public.availability_allocations for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy payment_installments_select on public.payment_installments for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy payments_select on public.payments for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy payment_events_select on public.payment_events for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- Functions -------------------------------------------------------------------
-- Functions are executable by PUBLIC by default; take that away, then grant the API surface
-- to signed-in users only. Each RPC still verifies membership itself.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.is_workspace_member(uuid),
  public.is_workspace_admin(uuid),
  public.create_hold(uuid, timestamptz, text),
  public.extend_hold(uuid, timestamptz),
  public.release_hold(uuid, text),
  public.confirm_candidate(uuid, numeric, text, numeric, numeric, text, boolean, uuid, text),
  public.create_booking(uuid, uuid, date, date, numeric, text, numeric, text, numeric, text),
  public.update_booking(uuid, date, date, numeric, text, numeric, numeric, text),
  public.set_booking_status(uuid, text, text, numeric),
  public.record_payment(uuid, numeric, date, text, text, text),
  public.correct_payment(uuid, numeric, date, text, text, text, text),
  public.void_payment(uuid, text),
  public.set_installments(uuid, jsonb),
  public.invite_member(uuid, text, text),
  public.revoke_invitation(uuid),
  public.accept_invitations(),
  public.remove_member(uuid, uuid),
  public.set_member_role(uuid, uuid, text),
  public.list_members(uuid)
to authenticated;
-- housekeeping_expire_holds() is deliberately not granted: run it as postgres / pg_cron.

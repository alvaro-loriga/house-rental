-- Rental manager: authorization helpers, guards and transactional RPCs.
--
-- Conventions
--   * Public RPCs are SECURITY DEFINER with an empty search_path and fully qualified names.
--     Each one authenticates the caller and checks workspace membership itself.
--   * Errors are raised with SQLSTATE P0001 and a stable, language-independent code as the
--     message (for example DATES_HELD). `detail` carries a JSON object with context.
--     The UI translates the code; see docs/RPC.md.
--   * Anything that changes availability first locks the property row (FOR UPDATE), then
--     reconciles expired holds against clock_timestamp(), then checks and writes. Two
--     competing requests for one property therefore run strictly one after the other.

-- ---------------------------------------------------------------------------
-- Authorization helpers usable from RLS policies
-- ---------------------------------------------------------------------------
create function public.is_workspace_member(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid())
  );
$$;

create function public.is_workspace_admin(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid()) and m.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Private helpers (schema `private` is not exposed through the API)
-- ---------------------------------------------------------------------------
create function private.fail(p_code text, p_detail jsonb default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '{}'::jsonb)::text;
end $$;

create function private.current_uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform private.fail('NOT_AUTHENTICATED');
  end if;
  return v_uid;
end $$;

create function private.require_member(p_workspace_id uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
begin
  if not exists (
    select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = v_uid
  ) then
    perform private.fail('NOT_A_MEMBER');
  end if;
  return v_uid;
end $$;

create function private.require_admin(p_workspace_id uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
begin
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = v_uid and m.role = 'admin'
  ) then
    perform private.fail('ADMIN_REQUIRED');
  end if;
  return v_uid;
end $$;

create function private.check_dates(p_start date, p_end date) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_start is null or p_end is null or p_end <= p_start then
    perform private.fail('INVALID_DATES');
  end if;
end $$;

-- Money must be present (unless p_nullable), non-negative (or strictly positive) and have at
-- most two decimals.
create function private.check_money(p_value numeric, p_positive boolean default false, p_nullable boolean default false)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then
    if p_nullable then return; end if;
    perform private.fail('INVALID_AMOUNT');
  end if;
  if p_value < 0 or (p_positive and p_value = 0) or p_value <> round(p_value, 2) or p_value >= 10000000000 then
    perform private.fail('INVALID_AMOUNT');
  end if;
end $$;

-- Marks holds whose deadline has passed as expired and frees their allocation.
-- Must be called with the property row locked.
create function private.reconcile_holds(p_property_id uuid) returns integer
language plpgsql set search_path = '' as $$
declare
  v_count integer;
begin
  with expired as (
    update public.temporary_holds h
       set status = 'expired'
     where h.property_id = p_property_id and h.status = 'active' and h.expires_at <= clock_timestamp()
    returning h.id, h.workspace_id, h.expires_at
  ), freed as (
    update public.availability_allocations a
       set active = false
      from expired e
     where a.hold_id = e.id
    returning a.id
  ), logged as (
    insert into public.hold_events (workspace_id, hold_id, event_type, actor_id, event_at, previous_values, new_values)
    select e.workspace_id, e.id, 'expired', null, e.expires_at,
           jsonb_build_object('status', 'active'), jsonb_build_object('status', 'expired')
      from expired e
    returning 1
  )
  select (select count(*) from freed) into v_count;
  return v_count;
end $$;

-- Membership check, property lock and hold reconciliation in one step.
create function private.lock_property(p_property_id uuid) returns public.properties
language plpgsql set search_path = '' as $$
declare
  v_property public.properties;
  v_workspace uuid;
begin
  select p.workspace_id into v_workspace from public.properties p where p.id = p_property_id;
  if not found then
    perform private.current_uid();
    perform private.fail('NOT_FOUND');
  end if;
  perform private.require_member(v_workspace);
  select p.* into v_property from public.properties p where p.id = p_property_id for update;
  perform private.reconcile_holds(p_property_id);
  return v_property;
end $$;

-- Raises DATES_BOOKED or DATES_HELD when an active allocation overlaps [p_start, p_end).
create function private.assert_free(
  p_property_id uuid, p_start date, p_end date,
  p_ignore_booking uuid default null, p_ignore_hold uuid default null
) returns void
language plpgsql set search_path = '' as $$
declare
  v_alloc public.availability_allocations;
  v_detail jsonb;
begin
  select a.* into v_alloc
    from public.availability_allocations a
   where a.property_id = p_property_id
     and a.active
     and a.stay && daterange(p_start, p_end, '[)')
     and coalesce(a.booking_id <> p_ignore_booking, true)
     and coalesce(a.hold_id <> p_ignore_hold, true)
   order by (a.kind = 'booking') desc, lower(a.stay)
   limit 1;
  if not found then
    return;
  end if;
  if v_alloc.kind = 'booking' then
    select jsonb_build_object('booking_id', b.id, 'guest_name', g.full_name,
                              'start_date', b.start_date, 'end_date', b.end_date)
      into v_detail
      from public.bookings b join public.guests g on g.id = b.guest_id
     where b.id = v_alloc.booking_id;
    perform private.fail('DATES_BOOKED', v_detail);
  else
    select jsonb_build_object('hold_id', h.id, 'candidate_id', h.candidate_id, 'guest_name', g.full_name,
                              'start_date', h.start_date, 'end_date', h.end_date, 'expires_at', h.expires_at)
      into v_detail
      from public.temporary_holds h
      join public.booking_candidates c on c.id = h.candidate_id
      join public.guests g on g.id = c.guest_id
     where h.id = v_alloc.hold_id;
    perform private.fail('DATES_HELD', v_detail);
  end if;
end $$;

-- Latest moment a hold on this stay may expire: check-in day at the property's local
-- check-in time (default 16:00 Europe/Madrid).
create function private.hold_cutoff(p_property public.properties, p_start date) returns timestamptz
language sql stable set search_path = '' as $$
  select (p_start + p_property.check_in_time) at time zone p_property.timezone;
$$;

create function private.booking_net_paid(p_booking_id uuid) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(case when p.payment_type = 'refund' then -p.amount else p.amount end), 0)
    from public.payments p
   where p.booking_id = p_booking_id and p.voided_at is null;
$$;

-- ---------------------------------------------------------------------------
-- Guards against direct client writes that would bypass the RPCs
-- ---------------------------------------------------------------------------
-- Clients may edit candidates directly, but the 'confirmed' status only moves through
-- confirm_candidate / set_booking_status (which run as the function owner).
-- These triggers run with the caller's privileges (so current_user tells a direct API write
-- from an RPC apart) and therefore raise directly instead of using private.fail().
create function private.guard_candidate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.status = 'confirmed' then
        raise exception using errcode = 'P0001', message = 'DIRECT_WRITE_FORBIDDEN', detail = '{}';
      end if;
    elsif (new.status is distinct from old.status and (new.status = 'confirmed' or old.status = 'confirmed'))
       or new.booking_period_id <> old.booking_period_id
       or new.guest_id <> old.guest_id then
      raise exception using errcode = 'P0001', message = 'DIRECT_WRITE_FORBIDDEN', detail = '{}';
    end if;
  end if;
  return new;
end $$;
create trigger guard_candidate before insert or update on public.booking_candidates
  for each row execute function private.guard_candidate();

-- A period's dates/property are frozen while a hold or a live booking was created from it,
-- because those copied the dates at creation time.
create function private.guard_period() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.start_date <> old.start_date or new.end_date <> old.end_date or new.property_id <> old.property_id then
    if exists (
      select 1 from public.temporary_holds h
        join public.booking_candidates c on c.id = h.candidate_id
       where c.booking_period_id = old.id and h.status = 'active'
    ) or exists (
      select 1 from public.bookings b where b.booking_period_id = old.id and b.status <> 'cancelled'
    ) then
      raise exception using errcode = 'P0001', message = 'PERIOD_LOCKED', detail = '{}';
    end if;
  end if;
  if current_user in ('authenticated', 'anon') and new.status = 'booked' and old.status <> 'booked' then
    raise exception using errcode = 'P0001', message = 'DIRECT_WRITE_FORBIDDEN', detail = '{}';
  end if;
  return new;
end $$;
create trigger guard_period before update on public.booking_periods
  for each row execute function private.guard_period();

-- ---------------------------------------------------------------------------
-- Temporary holds
-- ---------------------------------------------------------------------------
create function public.create_hold(p_candidate_id uuid, p_expires_at timestamptz, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_candidate public.booking_candidates;
  v_period public.booking_periods;
  v_property public.properties;
  v_hold_id uuid;
begin
  select c.* into v_candidate from public.booking_candidates c where c.id = p_candidate_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
  perform private.require_member(v_candidate.workspace_id);
  select bp.* into v_period from public.booking_periods bp where bp.id = v_candidate.booking_period_id;

  v_property := private.lock_property(v_period.property_id);

  -- Re-read under the lock: another session may have just confirmed or discarded them.
  select c.* into v_candidate from public.booking_candidates c where c.id = p_candidate_id;
  if v_candidate.status in ('confirmed', 'discarded') then
    perform private.fail('CANDIDATE_NOT_ELIGIBLE', jsonb_build_object('status', v_candidate.status));
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() then
    perform private.fail('HOLD_EXPIRY_IN_PAST');
  end if;
  if p_expires_at > private.hold_cutoff(v_property, v_period.start_date) then
    perform private.fail('HOLD_EXPIRY_AFTER_CHECKIN',
      jsonb_build_object('cutoff', private.hold_cutoff(v_property, v_period.start_date)));
  end if;
  perform private.assert_free(v_period.property_id, v_period.start_date, v_period.end_date);

  insert into public.temporary_holds (workspace_id, property_id, candidate_id, start_date, end_date, expires_at, created_by, notes)
  values (v_candidate.workspace_id, v_period.property_id, p_candidate_id, v_period.start_date, v_period.end_date,
          p_expires_at, v_uid, nullif(btrim(p_notes), ''))
  returning id into v_hold_id;

  insert into public.availability_allocations (workspace_id, property_id, kind, hold_id, stay)
  values (v_candidate.workspace_id, v_period.property_id, 'hold', v_hold_id,
          daterange(v_period.start_date, v_period.end_date, '[)'));

  insert into public.hold_events (workspace_id, hold_id, event_type, actor_id, new_values)
  values (v_candidate.workspace_id, v_hold_id, 'created', v_uid,
          jsonb_build_object('expires_at', p_expires_at, 'start_date', v_period.start_date, 'end_date', v_period.end_date));
  return v_hold_id;
end $$;

-- Loads a hold under the property lock and insists that it is still effective.
create function private.lock_active_hold(p_hold_id uuid) returns public.temporary_holds
language plpgsql set search_path = '' as $$
declare
  v_hold public.temporary_holds;
begin
  select h.* into v_hold from public.temporary_holds h where h.id = p_hold_id;
  if not found then
    perform private.current_uid();
    perform private.fail('NOT_FOUND');
  end if;
  perform private.lock_property(v_hold.property_id);
  select h.* into v_hold from public.temporary_holds h where h.id = p_hold_id;
  if v_hold.status = 'expired' then
    perform private.fail('HOLD_EXPIRED', jsonb_build_object('expires_at', v_hold.expires_at));
  elsif v_hold.status <> 'active' then
    perform private.fail('HOLD_NOT_ACTIVE', jsonb_build_object('status', v_hold.status));
  end if;
  return v_hold;
end $$;

create function public.extend_hold(p_hold_id uuid, p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_hold public.temporary_holds := private.lock_active_hold(p_hold_id);
  v_property public.properties;
begin
  select p.* into v_property from public.properties p where p.id = v_hold.property_id;
  if p_expires_at is null or p_expires_at <= clock_timestamp() then
    perform private.fail('HOLD_EXPIRY_IN_PAST');
  end if;
  if p_expires_at > private.hold_cutoff(v_property, v_hold.start_date) then
    perform private.fail('HOLD_EXPIRY_AFTER_CHECKIN',
      jsonb_build_object('cutoff', private.hold_cutoff(v_property, v_hold.start_date)));
  end if;
  update public.temporary_holds set expires_at = p_expires_at where id = p_hold_id;
  insert into public.hold_events (workspace_id, hold_id, event_type, actor_id, previous_values, new_values)
  values (v_hold.workspace_id, p_hold_id, 'extended', v_uid,
          jsonb_build_object('expires_at', v_hold.expires_at), jsonb_build_object('expires_at', p_expires_at));
end $$;

create function public.release_hold(p_hold_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_hold public.temporary_holds := private.lock_active_hold(p_hold_id);
begin
  update public.temporary_holds set status = 'released', released_at = clock_timestamp() where id = p_hold_id;
  update public.availability_allocations set active = false where hold_id = p_hold_id;
  insert into public.hold_events (workspace_id, hold_id, event_type, actor_id, previous_values, new_values, reason)
  values (v_hold.workspace_id, p_hold_id, 'released', v_uid,
          jsonb_build_object('status', 'active'), jsonb_build_object('status', 'released'), nullif(btrim(p_reason), ''));
end $$;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create function private.check_pricing(p_pricing_type text, p_unit_price numeric, p_total_price numeric, p_deposit numeric)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_pricing_type is null or p_pricing_type not in ('total', 'per_night', 'per_week', 'per_month') then
    perform private.fail('INVALID_PRICING_TYPE');
  end if;
  perform private.check_money(p_total_price);
  perform private.check_money(p_unit_price, false, true);
  perform private.check_money(p_deposit);
end $$;

-- Confirms a candidate: one transaction creates the confirmed booking, blocks the dates,
-- consumes the candidate's own hold (if any) and updates candidate and period.
-- If another candidate holds the dates, the caller must be an admin and pass that hold's id
-- plus a reason; the hold is then closed with an 'overridden' audit event.
create function public.confirm_candidate(
  p_candidate_id uuid,
  p_total_price numeric,
  p_pricing_type text default 'total',
  p_unit_price numeric default null,
  p_deposit_required numeric default 0,
  p_notes text default null,
  p_discard_others boolean default false,
  p_override_hold_id uuid default null,
  p_override_reason text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_candidate public.booking_candidates;
  v_period public.booking_periods;
  v_alloc record;
  v_hold public.temporary_holds;
  v_own_hold_id uuid;
  v_booking_id uuid;
  v_guest_name text;
begin
  select c.* into v_candidate from public.booking_candidates c where c.id = p_candidate_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
  perform private.require_member(v_candidate.workspace_id);
  select bp.* into v_period from public.booking_periods bp where bp.id = v_candidate.booking_period_id;
  perform private.check_pricing(p_pricing_type, p_unit_price, p_total_price, coalesce(p_deposit_required, 0));

  perform private.lock_property(v_period.property_id);

  select c.* into v_candidate from public.booking_candidates c where c.id = p_candidate_id;
  if v_candidate.status in ('confirmed', 'discarded') then
    perform private.fail('CANDIDATE_NOT_ELIGIBLE', jsonb_build_object('status', v_candidate.status));
  end if;

  for v_alloc in
    select a.* from public.availability_allocations a
     where a.property_id = v_period.property_id and a.active
       and a.stay && daterange(v_period.start_date, v_period.end_date, '[)')
     order by (a.kind = 'booking') desc
  loop
    if v_alloc.kind = 'booking' then
      perform private.assert_free(v_period.property_id, v_period.start_date, v_period.end_date);
    end if;
    select h.* into v_hold from public.temporary_holds h where h.id = v_alloc.hold_id;
    if v_hold.candidate_id = p_candidate_id then
      v_own_hold_id := v_hold.id;
    elsif p_override_hold_id is not null and p_override_hold_id = v_hold.id then
      perform private.require_admin(v_candidate.workspace_id);
      if nullif(btrim(p_override_reason), '') is null then
        perform private.fail('OVERRIDE_REASON_REQUIRED');
      end if;
      update public.temporary_holds set status = 'released', released_at = clock_timestamp() where id = v_hold.id;
      update public.availability_allocations set active = false where id = v_alloc.id;
      insert into public.hold_events (workspace_id, hold_id, event_type, actor_id, previous_values, new_values, reason)
      values (v_hold.workspace_id, v_hold.id, 'overridden', v_uid,
              jsonb_build_object('status', 'active'),
              jsonb_build_object('status', 'released', 'confirmed_candidate_id', p_candidate_id),
              btrim(p_override_reason));
    else
      -- Raises DATES_HELD with the holder's details.
      perform private.assert_free(v_period.property_id, v_period.start_date, v_period.end_date, null, v_own_hold_id);
    end if;
  end loop;

  insert into public.bookings (workspace_id, property_id, booking_period_id, candidate_id, guest_id, start_date, end_date,
                               pricing_type, unit_price, total_price, status, deposit_required, notes, created_by)
  values (v_candidate.workspace_id, v_period.property_id, v_period.id, p_candidate_id, v_candidate.guest_id,
          v_period.start_date, v_period.end_date, p_pricing_type, p_unit_price, p_total_price, 'confirmed',
          coalesce(p_deposit_required, 0), nullif(btrim(p_notes), ''), v_uid)
  returning id into v_booking_id;

  if v_own_hold_id is not null then
    -- Hand the nights over from the hold to the booking. Still inside the property lock,
    -- so nobody can slip in between these statements.
    update public.availability_allocations set active = false where hold_id = v_own_hold_id;
    update public.temporary_holds set status = 'converted', converted_booking_id = v_booking_id where id = v_own_hold_id;
    insert into public.hold_events (workspace_id, hold_id, event_type, actor_id, previous_values, new_values)
    values (v_candidate.workspace_id, v_own_hold_id, 'converted', v_uid,
            jsonb_build_object('status', 'active'),
            jsonb_build_object('status', 'converted', 'booking_id', v_booking_id));
  end if;

  insert into public.availability_allocations (workspace_id, property_id, kind, booking_id, stay)
  values (v_candidate.workspace_id, v_period.property_id, 'booking', v_booking_id,
          daterange(v_period.start_date, v_period.end_date, '[)'));

  update public.booking_candidates set status = 'confirmed' where id = p_candidate_id;
  update public.booking_periods set status = 'booked' where id = v_period.id;
  if coalesce(p_discard_others, false) then
    update public.booking_candidates
       set status = 'discarded'
     where booking_period_id = v_period.id and id <> p_candidate_id and status <> 'discarded';
  end if;

  select g.full_name into v_guest_name from public.guests g where g.id = v_candidate.guest_id;
  insert into public.booking_events (workspace_id, booking_id, event_type, actor_id, new_values)
  values (v_candidate.workspace_id, v_booking_id, 'confirmed', v_uid,
          jsonb_build_object('status', 'confirmed', 'start_date', v_period.start_date, 'end_date', v_period.end_date,
                             'total_price', p_total_price, 'candidate_id', p_candidate_id,
                             'from_hold_id', v_own_hold_id, 'guest_name', v_guest_name));
  return v_booking_id;
end $$;

-- Direct booking without a prospect. p_status is 'provisional' (does not block) or 'confirmed'.
create function public.create_booking(
  p_property_id uuid,
  p_guest_id uuid,
  p_start_date date,
  p_end_date date,
  p_total_price numeric,
  p_pricing_type text default 'total',
  p_unit_price numeric default null,
  p_status text default 'confirmed',
  p_deposit_required numeric default 0,
  p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_property public.properties;
  v_booking_id uuid;
begin
  v_property := private.lock_property(p_property_id);
  perform private.check_dates(p_start_date, p_end_date);
  perform private.check_pricing(p_pricing_type, p_unit_price, p_total_price, coalesce(p_deposit_required, 0));
  if p_status is null or p_status not in ('provisional', 'confirmed') then
    perform private.fail('INVALID_STATUS_TRANSITION');
  end if;
  if not exists (select 1 from public.guests g where g.id = p_guest_id and g.workspace_id = v_property.workspace_id) then
    perform private.fail('WORKSPACE_MISMATCH');
  end if;
  if p_status = 'confirmed' then
    perform private.assert_free(p_property_id, p_start_date, p_end_date);
  end if;

  insert into public.bookings (workspace_id, property_id, guest_id, start_date, end_date, pricing_type, unit_price,
                               total_price, status, deposit_required, notes, created_by)
  values (v_property.workspace_id, p_property_id, p_guest_id, p_start_date, p_end_date, p_pricing_type, p_unit_price,
          p_total_price, p_status, coalesce(p_deposit_required, 0), nullif(btrim(p_notes), ''), v_uid)
  returning id into v_booking_id;

  if p_status = 'confirmed' then
    insert into public.availability_allocations (workspace_id, property_id, kind, booking_id, stay)
    values (v_property.workspace_id, p_property_id, 'booking', v_booking_id, daterange(p_start_date, p_end_date, '[)'));
  end if;

  insert into public.booking_events (workspace_id, booking_id, event_type, actor_id, new_values)
  values (v_property.workspace_id, v_booking_id, case when p_status = 'confirmed' then 'confirmed' else 'created' end, v_uid,
          jsonb_build_object('status', p_status, 'start_date', p_start_date, 'end_date', p_end_date, 'total_price', p_total_price));
  return v_booking_id;
end $$;

create function public.update_booking(
  p_booking_id uuid,
  p_start_date date,
  p_end_date date,
  p_total_price numeric,
  p_pricing_type text,
  p_unit_price numeric,
  p_deposit_required numeric,
  p_notes text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_booking public.bookings;
begin
  select b.* into v_booking from public.bookings b where b.id = p_booking_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
  perform private.lock_property(v_booking.property_id);
  select b.* into v_booking from public.bookings b where b.id = p_booking_id;
  if v_booking.status = 'cancelled' then
    perform private.fail('BOOKING_NOT_EDITABLE');
  end if;
  perform private.check_dates(p_start_date, p_end_date);
  perform private.check_pricing(p_pricing_type, p_unit_price, p_total_price, coalesce(p_deposit_required, 0));

  if v_booking.status in ('confirmed', 'completed')
     and (p_start_date <> v_booking.start_date or p_end_date <> v_booking.end_date) then
    perform private.assert_free(v_booking.property_id, p_start_date, p_end_date, p_booking_id);
    update public.availability_allocations
       set stay = daterange(p_start_date, p_end_date, '[)')
     where booking_id = p_booking_id;
  end if;

  update public.bookings
     set start_date = p_start_date, end_date = p_end_date, total_price = p_total_price, pricing_type = p_pricing_type,
         unit_price = p_unit_price, deposit_required = coalesce(p_deposit_required, 0), notes = nullif(btrim(p_notes), '')
   where id = p_booking_id;

  insert into public.booking_events (workspace_id, booking_id, event_type, actor_id, previous_values, new_values)
  values (v_booking.workspace_id, p_booking_id, 'updated', v_uid,
          jsonb_build_object('start_date', v_booking.start_date, 'end_date', v_booking.end_date,
                             'total_price', v_booking.total_price, 'pricing_type', v_booking.pricing_type,
                             'unit_price', v_booking.unit_price, 'deposit_required', v_booking.deposit_required),
          jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'total_price', p_total_price,
                             'pricing_type', p_pricing_type, 'unit_price', p_unit_price,
                             'deposit_required', coalesce(p_deposit_required, 0)));
end $$;

-- Allowed transitions:
--   provisional -> confirmed | cancelled
--   confirmed   -> completed | cancelled (reason required)
--   completed   -> confirmed (undo a mistaken completion)
create function public.set_booking_status(
  p_booking_id uuid,
  p_status text,
  p_reason text default null,
  p_cancellation_fee numeric default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_booking public.bookings;
  v_event text;
begin
  select b.* into v_booking from public.bookings b where b.id = p_booking_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
  perform private.lock_property(v_booking.property_id);
  select b.* into v_booking from public.bookings b where b.id = p_booking_id;

  if v_booking.status = 'provisional' and p_status = 'confirmed' then
    perform private.assert_free(v_booking.property_id, v_booking.start_date, v_booking.end_date);
    insert into public.availability_allocations (workspace_id, property_id, kind, booking_id, stay)
    values (v_booking.workspace_id, v_booking.property_id, 'booking', p_booking_id,
            daterange(v_booking.start_date, v_booking.end_date, '[)'))
    on conflict (booking_id) do update set active = true, stay = excluded.stay;
    v_event := 'confirmed';
  elsif v_booking.status in ('provisional', 'confirmed') and p_status = 'cancelled' then
    if v_booking.status = 'confirmed' and nullif(btrim(p_reason), '') is null then
      perform private.fail('REASON_REQUIRED');
    end if;
    perform private.check_money(p_cancellation_fee, false, true);
    update public.availability_allocations set active = false where booking_id = p_booking_id;
    update public.bookings
       set cancelled_at = clock_timestamp(), cancellation_reason = nullif(btrim(p_reason), ''),
           cancellation_fee = p_cancellation_fee
     where id = p_booking_id;
    -- Give the originating prospect and period back to the pipeline.
    if v_booking.candidate_id is not null then
      update public.booking_candidates set status = 'discarded'
       where id = v_booking.candidate_id and status = 'confirmed';
    end if;
    if v_booking.booking_period_id is not null then
      update public.booking_periods set status = 'open'
       where id = v_booking.booking_period_id and status = 'booked';
    end if;
    v_event := 'cancelled';
  elsif v_booking.status = 'confirmed' and p_status = 'completed' then
    v_event := 'completed';
  elsif v_booking.status = 'completed' and p_status = 'confirmed' then
    v_event := 'reopened';
  else
    perform private.fail('INVALID_STATUS_TRANSITION', jsonb_build_object('from', v_booking.status, 'to', p_status));
  end if;

  update public.bookings set status = p_status where id = p_booking_id;
  insert into public.booking_events (workspace_id, booking_id, event_type, actor_id, previous_values, new_values, reason)
  values (v_booking.workspace_id, p_booking_id, v_event, v_uid,
          jsonb_build_object('status', v_booking.status),
          jsonb_build_object('status', p_status, 'cancellation_fee', p_cancellation_fee),
          nullif(btrim(p_reason), ''));
end $$;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create function private.check_payment_fields(p_amount numeric, p_date date, p_method text, p_type text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  perform private.check_money(p_amount, true);
  if p_date is null then perform private.fail('INVALID_DATES'); end if;
  if p_method is null or p_method not in ('bank_transfer', 'cash', 'bizum', 'card', 'other') then
    perform private.fail('INVALID_PAYMENT_METHOD');
  end if;
  if p_type is null or p_type not in ('deposit', 'partial_payment', 'final_payment', 'refund', 'other') then
    perform private.fail('INVALID_PAYMENT_TYPE');
  end if;
end $$;

-- Locks the booking row so payment changes for one booking are serialized.
create function private.lock_booking_for_payment(p_booking_id uuid) returns public.bookings
language plpgsql set search_path = '' as $$
declare
  v_booking public.bookings;
begin
  select b.* into v_booking from public.bookings b where b.id = p_booking_id;
  if not found then
    perform private.current_uid();
    perform private.fail('NOT_FOUND');
  end if;
  perform private.require_member(v_booking.workspace_id);
  select b.* into v_booking from public.bookings b where b.id = p_booking_id for update;
  return v_booking;
end $$;

create function public.record_payment(
  p_booking_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_payment_type text,
  p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_booking public.bookings := private.lock_booking_for_payment(p_booking_id);
  v_payment_id uuid;
begin
  perform private.check_payment_fields(p_amount, p_payment_date, p_payment_method, p_payment_type);
  if p_payment_type = 'refund' and p_amount > private.booking_net_paid(p_booking_id) then
    perform private.fail('REFUND_EXCEEDS_RECEIPTS',
      jsonb_build_object('net_paid', private.booking_net_paid(p_booking_id)));
  end if;
  insert into public.payments (workspace_id, booking_id, amount, payment_date, payment_method, payment_type, notes, created_by)
  values (v_booking.workspace_id, p_booking_id, p_amount, p_payment_date, p_payment_method, p_payment_type,
          nullif(btrim(p_notes), ''), v_uid)
  returning id into v_payment_id;
  insert into public.payment_events (workspace_id, payment_id, event_type, actor_id, new_values)
  values (v_booking.workspace_id, v_payment_id, 'created', v_uid,
          jsonb_build_object('amount', p_amount, 'payment_date', p_payment_date, 'payment_method', p_payment_method,
                             'payment_type', p_payment_type, 'notes', nullif(btrim(p_notes), '')));
  return v_payment_id;
end $$;

create function public.correct_payment(
  p_payment_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_payment_type text,
  p_notes text,
  p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_payment public.payments;
  v_booking public.bookings;
begin
  select p.* into v_payment from public.payments p where p.id = p_payment_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
  v_booking := private.lock_booking_for_payment(v_payment.booking_id);
  select p.* into v_payment from public.payments p where p.id = p_payment_id;
  if v_payment.voided_at is not null then perform private.fail('PAYMENT_VOIDED'); end if;
  if nullif(btrim(p_reason), '') is null then perform private.fail('REASON_REQUIRED'); end if;
  perform private.check_payment_fields(p_amount, p_payment_date, p_payment_method, p_payment_type);

  update public.payments
     set amount = p_amount, payment_date = p_payment_date, payment_method = p_payment_method,
         payment_type = p_payment_type, notes = nullif(btrim(p_notes), '')
   where id = p_payment_id;
  if private.booking_net_paid(v_booking.id) < 0 then
    perform private.fail('REFUND_EXCEEDS_RECEIPTS');
  end if;
  insert into public.payment_events (workspace_id, payment_id, event_type, actor_id, previous_values, new_values, reason)
  values (v_payment.workspace_id, p_payment_id, 'corrected', v_uid,
          jsonb_build_object('amount', v_payment.amount, 'payment_date', v_payment.payment_date,
                             'payment_method', v_payment.payment_method, 'payment_type', v_payment.payment_type,
                             'notes', v_payment.notes),
          jsonb_build_object('amount', p_amount, 'payment_date', p_payment_date, 'payment_method', p_payment_method,
                             'payment_type', p_payment_type, 'notes', nullif(btrim(p_notes), '')),
          btrim(p_reason));
end $$;

create function public.void_payment(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_payment public.payments;
  v_booking public.bookings;
begin
  select p.* into v_payment from public.payments p where p.id = p_payment_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
  v_booking := private.lock_booking_for_payment(v_payment.booking_id);
  select p.* into v_payment from public.payments p where p.id = p_payment_id;
  if v_payment.voided_at is not null then perform private.fail('PAYMENT_VOIDED'); end if;
  if nullif(btrim(p_reason), '') is null then perform private.fail('REASON_REQUIRED'); end if;

  update public.payments
     set voided_at = clock_timestamp(), voided_by = v_uid, void_reason = btrim(p_reason)
   where id = p_payment_id;
  if private.booking_net_paid(v_booking.id) < 0 then
    perform private.fail('REFUND_EXCEEDS_RECEIPTS');
  end if;
  insert into public.payment_events (workspace_id, payment_id, event_type, actor_id, previous_values, new_values, reason)
  values (v_payment.workspace_id, p_payment_id, 'voided', v_uid,
          jsonb_build_object('voided', false, 'amount', v_payment.amount),
          jsonb_build_object('voided', true), btrim(p_reason));
end $$;

-- Replaces the whole schedule of a booking in one transaction, so regenerating a proposed
-- schedule can never leave duplicates. p_items: [{"due_date":"2027-09-01","amount":550,"description":"..."}]
create function public.set_installments(p_booking_id uuid, p_items jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_booking public.bookings := private.lock_booking_for_payment(p_booking_id);
  v_item record;
  v_count integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    perform private.fail('INVALID_AMOUNT');
  end if;
  delete from public.payment_installments where booking_id = p_booking_id;
  for v_item in
    select * from jsonb_to_recordset(p_items) as x(due_date date, amount numeric, description text)
  loop
    if v_item.due_date is null then perform private.fail('INVALID_DATES'); end if;
    perform private.check_money(v_item.amount, true);
    insert into public.payment_installments (workspace_id, booking_id, due_date, amount, description)
    values (v_booking.workspace_id, p_booking_id, v_item.due_date, v_item.amount, nullif(btrim(v_item.description), ''));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Membership (invitation based; a new sign-up has no access until invited)
-- ---------------------------------------------------------------------------
create function public.invite_member(p_workspace_id uuid, p_email text, p_role text default 'member')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_admin(p_workspace_id);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if position('@' in v_email) < 2 then perform private.fail('INVALID_EMAIL'); end if;
  if p_role is null or p_role not in ('admin', 'member') then perform private.fail('INVALID_ROLE'); end if;
  if exists (
    select 1 from public.workspace_members m join auth.users u on u.id = m.user_id
     where m.workspace_id = p_workspace_id and lower(u.email) = v_email
  ) then
    perform private.fail('ALREADY_A_MEMBER');
  end if;
  update public.workspace_invitations set revoked_at = now()
   where workspace_id = p_workspace_id and email = v_email and accepted_at is null and revoked_at is null;
  insert into public.workspace_invitations (workspace_id, email, role, invited_by)
  values (p_workspace_id, v_email, p_role, v_uid)
  returning id into v_id;
  return v_id;
end $$;

create function public.revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_workspace uuid;
begin
  select i.workspace_id into v_workspace from public.workspace_invitations i where i.id = p_invitation_id;
  if not found then
    perform private.current_uid();
    perform private.fail('NOT_FOUND');
  end if;
  perform private.require_admin(v_workspace);
  update public.workspace_invitations set revoked_at = now()
   where id = p_invitation_id and accepted_at is null and revoked_at is null;
end $$;

-- Called by the app after sign-in. Turns pending invitations for the caller's *confirmed*
-- e-mail address into memberships. Returns how many workspaces were joined.
create function public.accept_invitations()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.current_uid();
  v_email text;
  v_inv record;
  v_count integer := 0;
begin
  select lower(u.email) into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then
    return 0;
  end if;
  for v_inv in
    select i.* from public.workspace_invitations i
     where i.email = v_email and i.accepted_at is null and i.revoked_at is null
     for update
  loop
    insert into public.workspace_members (workspace_id, user_id, role)
    values (v_inv.workspace_id, v_uid, v_inv.role)
    on conflict (workspace_id, user_id) do nothing;
    update public.workspace_invitations set accepted_at = now() where id = v_inv.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create function private.assert_not_last_admin(p_workspace_id uuid, p_user_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.workspace_members m where m.workspace_id = p_workspace_id for update;
  if not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = p_workspace_id and m.role = 'admin' and m.user_id <> p_user_id
  ) then
    perform private.fail('LAST_ADMIN');
  end if;
end $$;

create function public.remove_member(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin(p_workspace_id);
  perform private.assert_not_last_admin(p_workspace_id, p_user_id);
  delete from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id;
end $$;

create function public.set_member_role(p_workspace_id uuid, p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin(p_workspace_id);
  if p_role is null or p_role not in ('admin', 'member') then perform private.fail('INVALID_ROLE'); end if;
  if p_role <> 'admin' then
    perform private.assert_not_last_admin(p_workspace_id, p_user_id);
  end if;
  update public.workspace_members set role = p_role where workspace_id = p_workspace_id and user_id = p_user_id;
  if not found then perform private.fail('NOT_FOUND'); end if;
end $$;

create function public.list_members(p_workspace_id uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_member(p_workspace_id);
  return query
    select m.user_id, u.email::text, m.role, m.created_at
      from public.workspace_members m join auth.users u on u.id = m.user_id
     where m.workspace_id = p_workspace_id
     order by m.created_at;
end $$;

-- ---------------------------------------------------------------------------
-- Optional housekeeping (for pg_cron or manual runs). Availability never depends on it:
-- it only writes the persisted 'expired' status and audit event a little earlier.
-- ---------------------------------------------------------------------------
create function public.housekeeping_expire_holds()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_property uuid;
  v_total integer := 0;
begin
  for v_property in
    select distinct h.property_id from public.temporary_holds h
     where h.status = 'active' and h.expires_at <= clock_timestamp()
  loop
    perform 1 from public.properties p where p.id = v_property for update;
    v_total := v_total + private.reconcile_holds(v_property);
  end loop;
  return v_total;
end $$;

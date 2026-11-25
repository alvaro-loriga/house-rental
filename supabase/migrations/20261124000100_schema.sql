-- Rental manager: tables, constraints and indexes.
-- Every business table carries workspace_id and uses composite foreign keys, so a row can
-- never reference a property, guest, booking... that belongs to another workspace.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Workspaces and membership
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz
);
create unique index workspace_invitations_pending_idx
  on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

create table public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  locale text not null default 'es-ES' check (locale in ('es-ES', 'en-GB')),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Properties and guests
-- ---------------------------------------------------------------------------
create table public.properties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  name text not null check (length(btrim(name)) > 0),
  address text,
  timezone text not null default 'Europe/Madrid',
  -- Local check-in time. A temporary hold may not expire later than check-in day at this time.
  check_in_time time not null default '16:00',
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index properties_workspace_idx on public.properties (workspace_id);

create table public.guests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  full_name text not null check (length(btrim(full_name)) > 0),
  phone text,
  phone_normalized text generated always as (
    nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')
  ) stored,
  email text,
  notes text,
  archived_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index guests_workspace_idx on public.guests (workspace_id);
create index guests_phone_idx on public.guests (workspace_id, phone_normalized);
create index guests_email_idx on public.guests (workspace_id, lower(email));

-- ---------------------------------------------------------------------------
-- Potential periods and candidates (never block availability)
-- ---------------------------------------------------------------------------
create table public.booking_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open', 'booked', 'closed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  unique (id, workspace_id),
  foreign key (property_id, workspace_id) references public.properties (id, workspace_id) on delete restrict
);
create index booking_periods_property_idx on public.booking_periods (property_id, start_date);

create table public.booking_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  booking_period_id uuid not null,
  guest_id uuid not null,
  status text not null default 'interested'
    check (status in ('interested', 'undecided', 'awaiting_response', 'confirmed', 'discarded')),
  proposed_price numeric(12, 2) check (proposed_price is null or proposed_price >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (booking_period_id, guest_id),
  foreign key (booking_period_id, workspace_id) references public.booking_periods (id, workspace_id) on delete restrict,
  foreign key (guest_id, workspace_id) references public.guests (id, workspace_id) on delete restrict
);
create index booking_candidates_guest_idx on public.booking_candidates (guest_id);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null,
  booking_period_id uuid,
  candidate_id uuid,
  guest_id uuid not null,
  start_date date not null,
  end_date date not null,
  pricing_type text not null default 'total'
    check (pricing_type in ('total', 'per_night', 'per_week', 'per_month')),
  unit_price numeric(12, 2) check (unit_price is null or unit_price >= 0),
  total_price numeric(12, 2) not null check (total_price >= 0),
  status text not null default 'provisional'
    check (status in ('provisional', 'confirmed', 'cancelled', 'completed')),
  booking_date date not null default current_date,
  -- Booking-price deposit expected from the guest (0 = none). Informational: it produces a
  -- warning when unpaid, it never blocks confirmation. Not a refundable damage deposit.
  deposit_required numeric(12, 2) not null default 0 check (deposit_required >= 0),
  notes text,
  cancelled_at timestamptz,
  cancellation_reason text,
  cancellation_fee numeric(12, 2) check (cancellation_fee is null or cancellation_fee >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  unique (id, workspace_id),
  foreign key (property_id, workspace_id) references public.properties (id, workspace_id) on delete restrict,
  foreign key (guest_id, workspace_id) references public.guests (id, workspace_id) on delete restrict,
  foreign key (booking_period_id, workspace_id) references public.booking_periods (id, workspace_id) on delete restrict,
  foreign key (candidate_id, workspace_id) references public.booking_candidates (id, workspace_id) on delete restrict
);
create index bookings_property_idx on public.bookings (property_id, start_date);
create index bookings_guest_idx on public.bookings (guest_id);
create index bookings_workspace_status_idx on public.bookings (workspace_id, status);

create table public.booking_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  booking_id uuid not null,
  event_type text not null check (event_type in ('created', 'confirmed', 'updated', 'cancelled', 'completed', 'reopened')),
  actor_id uuid references auth.users (id) on delete set null,
  event_at timestamptz not null default now(),
  previous_values jsonb,
  new_values jsonb,
  reason text,
  foreign key (booking_id, workspace_id) references public.bookings (id, workspace_id) on delete restrict
);
create index booking_events_booking_idx on public.booking_events (booking_id, event_at);

-- ---------------------------------------------------------------------------
-- Temporary holds
-- ---------------------------------------------------------------------------
create table public.temporary_holds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null,
  candidate_id uuid not null,
  start_date date not null,
  end_date date not null,
  expires_at timestamptz not null,
  -- Persisted lifecycle. A hold is only *effective* while status = 'active' AND
  -- expires_at > now(); the persisted 'expired' value is written lazily by reconciliation.
  status text not null default 'active' check (status in ('active', 'released', 'expired', 'converted')),
  created_by uuid references auth.users (id) on delete set null,
  released_at timestamptz,
  converted_booking_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  unique (id, workspace_id),
  foreign key (property_id, workspace_id) references public.properties (id, workspace_id) on delete restrict,
  foreign key (candidate_id, workspace_id) references public.booking_candidates (id, workspace_id) on delete restrict,
  foreign key (converted_booking_id, workspace_id) references public.bookings (id, workspace_id) on delete restrict
);
create index temporary_holds_property_idx on public.temporary_holds (property_id, status, expires_at);
create index temporary_holds_candidate_idx on public.temporary_holds (candidate_id);

create table public.hold_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  hold_id uuid not null,
  event_type text not null
    check (event_type in ('created', 'extended', 'released', 'expired', 'overridden', 'converted')),
  actor_id uuid references auth.users (id) on delete set null, -- null for system expiration
  event_at timestamptz not null default now(),
  previous_values jsonb,
  new_values jsonb,
  reason text,
  foreign key (hold_id, workspace_id) references public.temporary_holds (id, workspace_id) on delete restrict
);
create index hold_events_hold_idx on public.hold_events (hold_id, event_at);

-- ---------------------------------------------------------------------------
-- Availability: the single source of truth for "who blocks which nights".
-- One row per hold and per confirmed/completed booking; `active` is switched off when the
-- hold is released/expired/converted or the booking is cancelled. The exclusion constraint
-- makes overlapping active rows for one property impossible, whatever code path wrote them.
-- Stays are half-open [check_in, check_out): the check-out day is not an occupied night.
-- ---------------------------------------------------------------------------
create table public.availability_allocations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null,
  kind text not null check (kind in ('hold', 'booking')),
  hold_id uuid unique,
  booking_id uuid unique,
  stay daterange not null check (not isempty(stay) and lower_inc(stay) and not upper_inc(stay)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (
    (kind = 'hold' and hold_id is not null and booking_id is null)
    or (kind = 'booking' and booking_id is not null and hold_id is null)
  ),
  foreign key (property_id, workspace_id) references public.properties (id, workspace_id) on delete restrict,
  foreign key (hold_id, workspace_id) references public.temporary_holds (id, workspace_id) on delete restrict,
  foreign key (booking_id, workspace_id) references public.bookings (id, workspace_id) on delete restrict,
  constraint availability_no_overlap
    exclude using gist (property_id with =, stay with &&) where (active)
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create table public.payment_installments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  booking_id uuid not null,
  due_date date not null,
  amount numeric(12, 2) not null check (amount > 0),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (booking_id, workspace_id) references public.bookings (id, workspace_id) on delete restrict
);
create index payment_installments_booking_idx on public.payment_installments (booking_id, due_date);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  booking_id uuid not null,
  -- Always positive. Refunds are stored positive and subtracted in the net calculation.
  amount numeric(12, 2) not null check (amount > 0),
  payment_date date not null,
  payment_method text not null
    check (payment_method in ('bank_transfer', 'cash', 'bizum', 'card', 'other')),
  payment_type text not null
    check (payment_type in ('deposit', 'partial_payment', 'final_payment', 'refund', 'other')),
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references auth.users (id) on delete set null,
  void_reason text,
  unique (id, workspace_id),
  foreign key (booking_id, workspace_id) references public.bookings (id, workspace_id) on delete restrict
);
create index payments_booking_idx on public.payments (booking_id, payment_date);
create index payments_workspace_date_idx on public.payments (workspace_id, payment_date);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  payment_id uuid not null,
  event_type text not null check (event_type in ('created', 'corrected', 'voided')),
  actor_id uuid references auth.users (id) on delete set null,
  event_at timestamptz not null default now(),
  previous_values jsonb,
  new_values jsonb,
  reason text,
  foreign key (payment_id, workspace_id) references public.payments (id, workspace_id) on delete restrict
);
create index payment_events_payment_idx on public.payment_events (payment_id, event_at);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger set_updated_at before update on public.properties for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.guests for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.booking_periods for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.booking_candidates for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.bookings for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.temporary_holds for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.payment_installments for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.payments for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.user_preferences for each row execute function private.set_updated_at();

create function private.validate_property() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception using errcode = 'P0001', message = 'INVALID_TIMEZONE';
  end if;
  return new;
end $$;
create trigger validate_property before insert or update on public.properties
  for each row execute function private.validate_property();

-- Rental manager: read models. All views are security_invoker, so the caller's RLS applies.

-- Bookings with guest, property and derived money figures.
--   net_paid       = non-voided receipts - non-voided refunds
--   outstanding    = total_price - net_paid (negative = visible credit; 0 for cancelled bookings,
--                    whose retained money is simply net_paid)
--   due_to_date    = scheduled instalments with due_date <= today (property time zone)
--   overdue        = instalments with due_date < today not yet covered by net_paid. Receipts are
--                    applied to the oldest instalments first.
create view public.v_bookings with (security_invoker = true) as
select
  b.id, b.workspace_id, b.property_id, b.booking_period_id, b.candidate_id, b.guest_id,
  b.start_date, b.end_date, (b.end_date - b.start_date) as nights,
  b.pricing_type, b.unit_price, b.total_price, b.status, b.booking_date, b.deposit_required, b.notes,
  b.cancelled_at, b.cancellation_reason, b.cancellation_fee, b.created_at, b.updated_at,
  g.full_name as guest_name, g.phone as guest_phone, g.email as guest_email,
  p.name as property_name, p.timezone as property_timezone,
  f.gross_receipts, f.refunds, f.net_paid, f.deposit_paid, f.last_payment_date,
  case when b.status = 'cancelled' then 0::numeric else b.total_price - f.net_paid end as outstanding,
  case
    when b.total_price = 0 then case when f.net_paid > 0 then 'overpaid' else 'paid' end
    when f.net_paid <= 0 then 'unpaid'
    when f.net_paid < b.total_price then 'partially_paid'
    when f.net_paid = b.total_price then 'paid'
    else 'overpaid'
  end as payment_status,
  case when b.total_price > 0 then round(f.net_paid / b.total_price * 100, 1) end as paid_percent,
  i.scheduled_total, i.due_to_date,
  case when b.status in ('confirmed', 'completed') then greatest(0::numeric, i.past_due - f.net_paid) else 0::numeric end as overdue
from public.bookings b
join public.guests g on g.id = b.guest_id
join public.properties p on p.id = b.property_id
cross join lateral (
  select
    coalesce(sum(pay.amount) filter (where pay.payment_type <> 'refund'), 0)::numeric as gross_receipts,
    coalesce(sum(pay.amount) filter (where pay.payment_type = 'refund'), 0)::numeric as refunds,
    coalesce(sum(case when pay.payment_type = 'refund' then -pay.amount else pay.amount end), 0)::numeric as net_paid,
    coalesce(sum(pay.amount) filter (where pay.payment_type = 'deposit'), 0)::numeric as deposit_paid,
    max(pay.payment_date) as last_payment_date
  from public.payments pay
  where pay.booking_id = b.id and pay.voided_at is null
) f
cross join lateral (
  select
    coalesce(sum(pi.amount), 0)::numeric as scheduled_total,
    coalesce(sum(pi.amount) filter (where pi.due_date <= (now() at time zone p.timezone)::date), 0)::numeric as due_to_date,
    coalesce(sum(pi.amount) filter (where pi.due_date < (now() at time zone p.timezone)::date), 0)::numeric as past_due
  from public.payment_installments pi
  where pi.booking_id = b.id
) i;

-- Holds with their effective state at query time (database clock).
create view public.v_holds with (security_invoker = true) as
select
  h.id, h.workspace_id, h.property_id, h.candidate_id, h.start_date, h.end_date, h.expires_at, h.status,
  h.released_at, h.converted_booking_id, h.notes, h.created_by, h.created_at, h.updated_at,
  (h.status = 'active' and h.expires_at > now()) as is_effective,
  case when h.status = 'active' and h.expires_at <= now() then 'expired' else h.status end as effective_status,
  c.booking_period_id, c.guest_id, c.status as candidate_status,
  g.full_name as guest_name, g.phone as guest_phone,
  p.name as property_name, p.timezone as property_timezone
from public.temporary_holds h
join public.booking_candidates c on c.id = h.candidate_id
join public.guests g on g.id = c.guest_id
join public.properties p on p.id = h.property_id;

-- What blocks the calendar right now: confirmed/completed bookings and effective holds.
create view public.v_blocking with (security_invoker = true) as
select
  a.id, a.workspace_id, a.property_id, a.kind, a.hold_id, a.booking_id,
  lower(a.stay) as start_date, upper(a.stay) as end_date,
  coalesce(bg.full_name, hg.full_name) as guest_name,
  b.status as booking_status, h.expires_at, h.candidate_id
from public.availability_allocations a
left join public.bookings b on b.id = a.booking_id
left join public.guests bg on bg.id = b.guest_id
left join public.temporary_holds h on h.id = a.hold_id
left join public.booking_candidates hc on hc.id = h.candidate_id
left join public.guests hg on hg.id = hc.guest_id
where a.active and (a.kind = 'booking' or h.expires_at > now());

create view public.v_candidates with (security_invoker = true) as
select
  c.id, c.workspace_id, c.booking_period_id, c.guest_id, c.status, c.proposed_price, c.notes,
  c.created_at, c.updated_at,
  g.full_name as guest_name, g.phone as guest_phone, g.email as guest_email,
  bp.property_id, bp.start_date, bp.end_date, bp.status as period_status,
  p.name as property_name
from public.booking_candidates c
join public.guests g on g.id = c.guest_id
join public.booking_periods bp on bp.id = c.booking_period_id
join public.properties p on p.id = bp.property_id;

create view public.v_payments with (security_invoker = true) as
select
  pay.id, pay.workspace_id, pay.booking_id, pay.amount, pay.payment_date, pay.payment_method, pay.payment_type,
  pay.notes, pay.created_by, pay.created_at, pay.updated_at, pay.voided_at, pay.void_reason,
  case when pay.payment_type = 'refund' then -pay.amount else pay.amount end as signed_amount,
  b.start_date, b.end_date, b.status as booking_status, b.guest_id, b.property_id,
  g.full_name as guest_name, p.name as property_name
from public.payments pay
join public.bookings b on b.id = pay.booking_id
join public.guests g on g.id = b.guest_id
join public.properties p on p.id = b.property_id;

create view public.v_guests with (security_invoker = true) as
select
  g.id, g.workspace_id, g.full_name, g.phone, g.phone_normalized, g.email, g.notes, g.archived_at,
  g.anonymized_at, g.created_at, g.updated_at,
  s.bookings_count, s.total_agreed, s.last_stay_end, cs.candidates_count
from public.guests g
cross join lateral (
  select count(*)::int as bookings_count,
         coalesce(sum(b.total_price), 0)::numeric as total_agreed,
         max(b.end_date) as last_stay_end
    from public.bookings b
   where b.guest_id = g.id and b.status in ('confirmed', 'completed')
) s
cross join lateral (
  select count(*)::int as candidates_count from public.booking_candidates c where c.guest_id = g.id
) cs;

revoke all on public.v_bookings, public.v_holds, public.v_blocking, public.v_candidates, public.v_payments, public.v_guests
  from anon, authenticated, public;
grant select on public.v_bookings, public.v_holds, public.v_blocking, public.v_candidates, public.v_payments, public.v_guests
  to authenticated;

// Typed data access. UI code never talks to Supabase directly: reads go through the views,
// and every availability- or money-changing action goes through an RPC (see docs/RPC.md).
import { supabase } from '../lib/supabase';
import type {
  AuditEvent,
  Blocking,
  Booking,
  Candidate,
  CandidateStatus,
  Guest,
  Hold,
  Installment,
  Invitation,
  Member,
  MemberRole,
  Payment,
  PaymentMethod,
  PaymentType,
  Period,
  PeriodStatus,
  Property,
  Workspace,
  WorkspaceMembership,
} from '../types/database';
import type { ISODate } from '../utils/dates';
import { toAppError } from '../utils/errors';
import type { AppLocale } from '../utils/format';
import type { PricingType } from '../utils/pricing';

interface Result<T> {
  data: T | null;
  error: unknown;
}

async function unwrap<T>(request: PromiseLike<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await request;
  } catch (error) {
    throw toAppError(error);
  }
  if (result.error) throw toAppError(result.error);
  return result.data as T;
}

const rpc = <T>(fn: string, args?: Record<string, unknown>) => unwrap<T>(supabase.rpc(fn, args));

const list = <T>(source: string, workspaceId: string, order: string, ascending = true) =>
  unwrap<T[]>(supabase.from(source).select('*').eq('workspace_id', workspaceId).order(order, { ascending }));

const blankToNull = (value: string | null | undefined) => {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
};

// --- Session, workspaces, preferences ---------------------------------------
export const acceptInvitations = () => rpc<number>('accept_invitations');
export const listWorkspaces = () => unwrap<Workspace[]>(supabase.from('workspaces').select('*').order('name'));
export const listMyMemberships = (userId: string) =>
  unwrap<WorkspaceMembership[]>(supabase.from('workspace_members').select('*').eq('user_id', userId));

export async function getPreferredLocale(userId: string): Promise<AppLocale | null> {
  const rows = await unwrap<{ locale: AppLocale }[]>(supabase.from('user_preferences').select('locale').eq('user_id', userId));
  return rows[0]?.locale ?? null;
}
export const savePreferredLocale = (userId: string, locale: AppLocale) =>
  unwrap(supabase.from('user_preferences').upsert({ user_id: userId, locale }, { onConflict: 'user_id' }));

// --- Members -----------------------------------------------------------------
export const listMembers = (workspaceId: string) => rpc<Member[]>('list_members', { p_workspace_id: workspaceId });
export const listInvitations = (workspaceId: string) =>
  unwrap<Invitation[]>(
    supabase.from('workspace_invitations').select('*').eq('workspace_id', workspaceId).is('accepted_at', null).is('revoked_at', null).order('created_at'),
  );
export const inviteMember = (workspaceId: string, email: string, role: MemberRole) =>
  rpc<string>('invite_member', { p_workspace_id: workspaceId, p_email: email, p_role: role });
export const revokeInvitation = (id: string) => rpc<void>('revoke_invitation', { p_invitation_id: id });
export const removeMember = (workspaceId: string, userId: string) =>
  rpc<void>('remove_member', { p_workspace_id: workspaceId, p_user_id: userId });
export const setMemberRole = (workspaceId: string, userId: string, role: MemberRole) =>
  rpc<void>('set_member_role', { p_workspace_id: workspaceId, p_user_id: userId, p_role: role });

// --- Properties ----------------------------------------------------------------
export const listProperties = (workspaceId: string) => list<Property>('properties', workspaceId, 'name');

export interface PropertyInput {
  name: string;
  address: string;
  timezone: string;
  notes: string;
}
const propertyRow = (input: PropertyInput) => ({
  name: input.name.trim(),
  address: blankToNull(input.address),
  timezone: input.timezone.trim(),
  notes: blankToNull(input.notes),
});
export const createProperty = (workspaceId: string, input: PropertyInput) =>
  unwrap(supabase.from('properties').insert({ workspace_id: workspaceId, ...propertyRow(input) }));
export const updateProperty = (id: string, input: PropertyInput) => unwrap(supabase.from('properties').update(propertyRow(input)).eq('id', id));
export const setPropertyArchived = (id: string, archived: boolean) =>
  unwrap(supabase.from('properties').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', id));

// --- Guests --------------------------------------------------------------------
export const listGuests = (workspaceId: string) => list<Guest>('v_guests', workspaceId, 'full_name');

export interface GuestInput {
  full_name: string;
  phone: string;
  email: string;
  notes: string;
}
const guestRow = (input: GuestInput) => ({
  full_name: input.full_name.trim(),
  phone: blankToNull(input.phone),
  email: blankToNull(input.email),
  notes: blankToNull(input.notes),
});
export async function createGuest(workspaceId: string, input: GuestInput): Promise<string> {
  const row = await unwrap<{ id: string }>(
    supabase.from('guests').insert({ workspace_id: workspaceId, ...guestRow(input) }).select('id').single(),
  );
  return row.id;
}
export const updateGuest = (id: string, input: GuestInput) => unwrap(supabase.from('guests').update(guestRow(input)).eq('id', id));
export const setGuestArchived = (id: string, archived: boolean) =>
  unwrap(supabase.from('guests').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', id));
/** Removes contact details but keeps the row, so bookings and payments stay intact. */
export const anonymizeGuest = (id: string, placeholderName: string) =>
  unwrap(
    supabase
      .from('guests')
      .update({ full_name: placeholderName, phone: null, email: null, notes: null, anonymized_at: new Date().toISOString(), archived_at: new Date().toISOString() })
      .eq('id', id),
  );

// --- Periods and candidates ------------------------------------------------------
export const listPeriods = (workspaceId: string) => list<Period>('booking_periods', workspaceId, 'start_date');
export const listCandidates = (workspaceId: string) => list<Candidate>('v_candidates', workspaceId, 'created_at');

export async function createPeriod(workspaceId: string, propertyId: string, start: ISODate, end: ISODate, notes: string): Promise<string> {
  const row = await unwrap<{ id: string }>(
    supabase
      .from('booking_periods')
      .insert({ workspace_id: workspaceId, property_id: propertyId, start_date: start, end_date: end, notes: blankToNull(notes) })
      .select('id')
      .single(),
  );
  return row.id;
}
export const updatePeriod = (id: string, patch: { start_date?: ISODate; end_date?: ISODate; status?: PeriodStatus; notes?: string | null }) =>
  unwrap(supabase.from('booking_periods').update(patch).eq('id', id));

export interface CandidateInput {
  status: CandidateStatus;
  proposed_price: number | null;
  notes: string;
}
export const createCandidate = (workspaceId: string, periodId: string, guestId: string, input: CandidateInput) =>
  unwrap(
    supabase.from('booking_candidates').insert({
      workspace_id: workspaceId,
      booking_period_id: periodId,
      guest_id: guestId,
      status: input.status,
      proposed_price: input.proposed_price,
      notes: blankToNull(input.notes),
    }),
  );
export const updateCandidate = (id: string, input: CandidateInput) =>
  unwrap(
    supabase.from('booking_candidates').update({ status: input.status, proposed_price: input.proposed_price, notes: blankToNull(input.notes) }).eq('id', id),
  );
export const setCandidateStatus = (id: string, status: CandidateStatus) =>
  unwrap(supabase.from('booking_candidates').update({ status }).eq('id', id));

// --- Holds -----------------------------------------------------------------------
export const listHolds = (workspaceId: string) => list<Hold>('v_holds', workspaceId, 'expires_at', false);
export const listBlocking = (workspaceId: string) => list<Blocking>('v_blocking', workspaceId, 'start_date');
export const listHoldEvents = (holdId: string) =>
  unwrap<AuditEvent[]>(supabase.from('hold_events').select('*').eq('hold_id', holdId).order('event_at'));

export const createHold = (candidateId: string, expiresAt: Date, notes = '') =>
  rpc<string>('create_hold', { p_candidate_id: candidateId, p_expires_at: expiresAt.toISOString(), p_notes: blankToNull(notes) });
export const extendHold = (holdId: string, expiresAt: Date) =>
  rpc<void>('extend_hold', { p_hold_id: holdId, p_expires_at: expiresAt.toISOString() });
export const releaseHold = (holdId: string, reason: string) => rpc<void>('release_hold', { p_hold_id: holdId, p_reason: blankToNull(reason) });

// --- Bookings --------------------------------------------------------------------
export const listBookings = (workspaceId: string) => list<Booking>('v_bookings', workspaceId, 'start_date');
export const listBookingEvents = (bookingId: string) =>
  unwrap<AuditEvent[]>(supabase.from('booking_events').select('*').eq('booking_id', bookingId).order('event_at'));

export interface PriceInput {
  pricing_type: PricingType;
  unit_price: number | null;
  total_price: number;
  deposit_required: number;
  notes: string;
}

export interface ConfirmCandidateInput extends PriceInput {
  discardOthers: boolean;
  overrideHoldId?: string | null;
  overrideReason?: string;
}
export const confirmCandidate = (candidateId: string, input: ConfirmCandidateInput) =>
  rpc<string>('confirm_candidate', {
    p_candidate_id: candidateId,
    p_total_price: input.total_price,
    p_pricing_type: input.pricing_type,
    p_unit_price: input.unit_price,
    p_deposit_required: input.deposit_required,
    p_notes: blankToNull(input.notes),
    p_discard_others: input.discardOthers,
    p_override_hold_id: input.overrideHoldId ?? null,
    p_override_reason: blankToNull(input.overrideReason),
  });

export interface BookingInput extends PriceInput {
  start_date: ISODate;
  end_date: ISODate;
}
export const createBooking = (propertyId: string, guestId: string, status: 'provisional' | 'confirmed', input: BookingInput) =>
  rpc<string>('create_booking', {
    p_property_id: propertyId,
    p_guest_id: guestId,
    p_start_date: input.start_date,
    p_end_date: input.end_date,
    p_total_price: input.total_price,
    p_pricing_type: input.pricing_type,
    p_unit_price: input.unit_price,
    p_status: status,
    p_deposit_required: input.deposit_required,
    p_notes: blankToNull(input.notes),
  });
export const updateBooking = (bookingId: string, input: BookingInput) =>
  rpc<void>('update_booking', {
    p_booking_id: bookingId,
    p_start_date: input.start_date,
    p_end_date: input.end_date,
    p_total_price: input.total_price,
    p_pricing_type: input.pricing_type,
    p_unit_price: input.unit_price,
    p_deposit_required: input.deposit_required,
    p_notes: blankToNull(input.notes),
  });
export const setBookingStatus = (
  bookingId: string,
  status: 'confirmed' | 'cancelled' | 'completed',
  reason = '',
  cancellationFee: number | null = null,
) =>
  rpc<void>('set_booking_status', {
    p_booking_id: bookingId,
    p_status: status,
    p_reason: blankToNull(reason),
    p_cancellation_fee: cancellationFee,
  });

// --- Payments --------------------------------------------------------------------
export const listPayments = (workspaceId: string) => list<Payment>('v_payments', workspaceId, 'payment_date', false);
export const listInstallments = (bookingId: string) =>
  unwrap<Installment[]>(supabase.from('payment_installments').select('*').eq('booking_id', bookingId).order('due_date'));
export const listPaymentEvents = (paymentId: string) =>
  unwrap<AuditEvent[]>(supabase.from('payment_events').select('*').eq('payment_id', paymentId).order('event_at'));

export interface PaymentInput {
  amount: number;
  payment_date: ISODate;
  payment_method: PaymentMethod;
  payment_type: PaymentType;
  notes: string;
}
export const recordPayment = (bookingId: string, input: PaymentInput) =>
  rpc<string>('record_payment', {
    p_booking_id: bookingId,
    p_amount: input.amount,
    p_payment_date: input.payment_date,
    p_payment_method: input.payment_method,
    p_payment_type: input.payment_type,
    p_notes: blankToNull(input.notes),
  });
export const correctPayment = (paymentId: string, input: PaymentInput, reason: string) =>
  rpc<void>('correct_payment', {
    p_payment_id: paymentId,
    p_amount: input.amount,
    p_payment_date: input.payment_date,
    p_payment_method: input.payment_method,
    p_payment_type: input.payment_type,
    p_notes: blankToNull(input.notes),
    p_reason: reason,
  });
export const voidPayment = (paymentId: string, reason: string) => rpc<void>('void_payment', { p_payment_id: paymentId, p_reason: reason });
export const setInstallments = (bookingId: string, items: { due_date: ISODate; amount: number; description?: string | null }[]) =>
  rpc<number>('set_installments', { p_booking_id: bookingId, p_items: items });

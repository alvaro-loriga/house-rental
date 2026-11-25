// Row types for the tables and views the app reads.
//
// These are written by hand to match supabase/migrations. Once the project is linked to a
// Supabase instance, `npm run gen:types` writes the generated equivalent to
// src/types/database.generated.ts, which can replace this file.

import type { ISODate } from '../utils/dates';
import type { PricingType } from '../utils/pricing';

export type MemberRole = 'admin' | 'member';
export type CandidateStatus = 'interested' | 'undecided' | 'awaiting_response' | 'confirmed' | 'discarded';
export type PeriodStatus = 'open' | 'booked' | 'closed' | 'cancelled';
export type BookingStatus = 'provisional' | 'confirmed' | 'cancelled' | 'completed';
export type HoldStatus = 'active' | 'released' | 'expired' | 'converted';
export type PaymentType = 'deposit' | 'partial_payment' | 'final_payment' | 'refund' | 'other';
export type PaymentMethod = 'bank_transfer' | 'cash' | 'bizum' | 'card' | 'other';
export type PaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overpaid';

export const CANDIDATE_STATUSES: CandidateStatus[] = ['interested', 'undecided', 'awaiting_response', 'confirmed', 'discarded'];
export const EDITABLE_CANDIDATE_STATUSES: CandidateStatus[] = ['interested', 'undecided', 'awaiting_response', 'discarded'];
export const BOOKING_STATUSES: BookingStatus[] = ['provisional', 'confirmed', 'completed', 'cancelled'];
export const PAYMENT_TYPES: PaymentType[] = ['deposit', 'partial_payment', 'final_payment', 'refund', 'other'];
export const PAYMENT_METHODS: PaymentMethod[] = ['bank_transfer', 'cash', 'bizum', 'card', 'other'];

export interface Workspace {
  id: string;
  name: string;
}

export interface WorkspaceMembership {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
}

export interface Member {
  user_id: string;
  email: string;
  role: MemberRole;
  created_at: string;
}

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role: MemberRole;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface Property {
  id: string;
  workspace_id: string;
  name: string;
  address: string | null;
  timezone: string;
  check_in_time: string;
  notes: string | null;
  archived_at: string | null;
}

export interface Guest {
  id: string;
  workspace_id: string;
  full_name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  notes: string | null;
  archived_at: string | null;
  anonymized_at: string | null;
  created_at: string;
  bookings_count: number;
  total_agreed: number;
  last_stay_end: ISODate | null;
  candidates_count: number;
}

export interface Period {
  id: string;
  workspace_id: string;
  property_id: string;
  start_date: ISODate;
  end_date: ISODate;
  status: PeriodStatus;
  notes: string | null;
  created_at: string;
}

export interface Candidate {
  id: string;
  workspace_id: string;
  booking_period_id: string;
  guest_id: string;
  status: CandidateStatus;
  proposed_price: number | null;
  notes: string | null;
  created_at: string;
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  property_id: string;
  start_date: ISODate;
  end_date: ISODate;
  period_status: PeriodStatus;
  property_name: string;
}

export interface Hold {
  id: string;
  workspace_id: string;
  property_id: string;
  candidate_id: string;
  start_date: ISODate;
  end_date: ISODate;
  expires_at: string;
  status: HoldStatus;
  released_at: string | null;
  converted_booking_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  is_effective: boolean;
  effective_status: HoldStatus;
  booking_period_id: string;
  guest_id: string;
  candidate_status: CandidateStatus;
  guest_name: string;
  guest_phone: string | null;
  property_name: string;
  property_timezone: string;
}

export interface Blocking {
  id: string;
  workspace_id: string;
  property_id: string;
  kind: 'hold' | 'booking';
  hold_id: string | null;
  booking_id: string | null;
  start_date: ISODate;
  end_date: ISODate;
  guest_name: string;
  booking_status: BookingStatus | null;
  expires_at: string | null;
  candidate_id: string | null;
}

export interface Booking {
  id: string;
  workspace_id: string;
  property_id: string;
  booking_period_id: string | null;
  candidate_id: string | null;
  guest_id: string;
  start_date: ISODate;
  end_date: ISODate;
  nights: number;
  pricing_type: PricingType;
  unit_price: number | null;
  total_price: number;
  status: BookingStatus;
  booking_date: ISODate;
  deposit_required: number;
  notes: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancellation_fee: number | null;
  created_at: string;
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  property_name: string;
  property_timezone: string;
  gross_receipts: number;
  refunds: number;
  net_paid: number;
  deposit_paid: number;
  last_payment_date: ISODate | null;
  outstanding: number;
  payment_status: PaymentStatus;
  paid_percent: number | null;
  scheduled_total: number;
  due_to_date: number;
  overdue: number;
}

export interface Installment {
  id: string;
  booking_id: string;
  due_date: ISODate;
  amount: number;
  description: string | null;
}

export interface Payment {
  id: string;
  workspace_id: string;
  booking_id: string;
  amount: number;
  signed_amount: number;
  payment_date: ISODate;
  payment_method: PaymentMethod;
  payment_type: PaymentType;
  notes: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  start_date: ISODate;
  end_date: ISODate;
  booking_status: BookingStatus;
  guest_id: string;
  property_id: string;
  guest_name: string;
  property_name: string;
}

export interface AuditEvent {
  id: string;
  event_type: string;
  actor_id: string | null;
  event_at: string;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
}

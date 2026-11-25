import { daysInMonth, makeDate, nightsBetween, nightsWithin, type ISODate } from './dates';
import { fromCents, toCents } from './money';

export interface ReportBooking {
  property_id: string;
  start_date: ISODate;
  end_date: ISODate;
  total_price: number;
  status: string;
  outstanding: number;
  overdue: number;
}

export interface ReportPayment {
  property_id: string;
  payment_date: ISODate;
  payment_type: string;
  amount: number;
  voided_at: string | null;
}

export interface YearReport {
  year: number;
  /** Agreed price of non-cancelled stays, attributed to the year by occupied nights. */
  agreedValue: number;
  /** Money actually received / refunded with a payment date in the year. */
  receipts: number;
  refunds: number;
  netReceipts: number;
  /** Net receipts per calendar month (index 0 = January). */
  monthlyNet: number[];
  /** Still owed on confirmed and completed bookings, whatever their year (credits excluded). */
  outstanding: number;
  /** Scheduled instalments already past due and not covered by receipts. */
  overdue: number;
  bookingsCount: number;
  occupiedNights: number;
  availableNights: number;
  /** 0..1 */
  occupancy: number;
  averagePerNight: number | null;
}

const BLOCKING = new Set(['confirmed', 'completed']);

/**
 * Share of a booking's agreed total that belongs to [from, to), proportional to the nights
 * inside the range. Computed on cumulative cents so the shares of consecutive ranges add up
 * to the total exactly (a stay crossing New Year is split without losing a cent).
 */
export function allocateByNights(total: number, start: ISODate, end: ISODate, from: ISODate, to: ISODate): number {
  const nights = nightsBetween(start, end);
  if (nights <= 0) return 0;
  const cents = toCents(total);
  const before = nightsWithin(start, end, start, from);
  const inside = nightsWithin(start, end, from, to);
  const cumulative = (n: number) => Math.round((cents * n) / nights);
  return fromCents(cumulative(before + inside) - cumulative(before));
}

/**
 * Yearly figures for the given bookings and payments (already filtered to the properties in
 * scope). Occupancy counts confirmed and completed nights only: candidates, holds, provisional
 * and cancelled bookings never count. The denominator is every calendar night of the year for
 * each property in scope.
 */
export function buildYearReport(bookings: ReportBooking[], payments: ReportPayment[], year: number, propertyCount: number): YearReport {
  const from = makeDate(year, 1, 1);
  const to = makeDate(year + 1, 1, 1);
  let agreed = 0;
  let occupiedNights = 0;
  let bookingsCount = 0;
  let outstanding = 0;
  let overdue = 0;

  for (const b of bookings) {
    if (!BLOCKING.has(b.status)) continue;
    outstanding += Math.max(0, toCents(b.outstanding));
    overdue += toCents(b.overdue);
    const nights = nightsWithin(b.start_date, b.end_date, from, to);
    if (nights === 0) continue;
    bookingsCount++;
    occupiedNights += nights;
    agreed += toCents(allocateByNights(b.total_price, b.start_date, b.end_date, from, to));
  }

  let receipts = 0;
  let refunds = 0;
  const monthly = Array.from({ length: 12 }, () => 0);
  for (const p of payments) {
    if (p.voided_at || p.payment_date < from || p.payment_date >= to) continue;
    const cents = toCents(p.amount);
    const month = Number(p.payment_date.slice(5, 7)) - 1;
    if (p.payment_type === 'refund') {
      refunds += cents;
      monthly[month] -= cents;
    } else {
      receipts += cents;
      monthly[month] += cents;
    }
  }

  let daysInYear = 0;
  for (let m = 1; m <= 12; m++) daysInYear += daysInMonth(year, m);
  const availableNights = daysInYear * Math.max(0, propertyCount);

  return {
    year,
    agreedValue: fromCents(agreed),
    receipts: fromCents(receipts),
    refunds: fromCents(refunds),
    netReceipts: fromCents(receipts - refunds),
    monthlyNet: monthly.map(fromCents),
    outstanding: fromCents(outstanding),
    overdue: fromCents(overdue),
    bookingsCount,
    occupiedNights,
    availableNights,
    occupancy: availableNights > 0 ? occupiedNights / availableNights : 0,
    averagePerNight: occupiedNights > 0 ? fromCents(Math.round(agreed / occupiedNights)) : null,
  };
}

export interface ScheduleItem {
  due_date: ISODate;
  amount: number;
}

export type InstallmentState = 'paid' | 'partial' | 'overdue' | 'due_today' | 'upcoming';

/**
 * Applies the net amount paid to instalments, oldest first (the same convention as the
 * database view), and tells for each one how much is covered and whether it is overdue.
 */
export function allocateToInstallments<T extends ScheduleItem>(items: T[], netPaid: number, today: ISODate) {
  let remaining = Math.max(0, toCents(netPaid));
  return [...items]
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .map((item) => {
      const amount = toCents(item.amount);
      const covered = Math.min(amount, remaining);
      remaining -= covered;
      let state: InstallmentState;
      if (covered >= amount) state = 'paid';
      else if (item.due_date < today) state = 'overdue';
      else if (item.due_date === today) state = 'due_today';
      else state = covered > 0 ? 'partial' : 'upcoming';
      return { ...item, covered: fromCents(covered), pending: fromCents(amount - covered), state };
    });
}

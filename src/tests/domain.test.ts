// Unit tests for the pure domain helpers. The test process runs with TZ=America/New_York
// (see vitest.config.ts), so every assertion here also proves independence from the device
// time zone.
import { describe, expect, it } from 'vitest';
import { describeDay } from '../features/calendar/CalendarPage';
import type { Blocking, Candidate, Period } from '../types/database';
import { availabilityFor } from '../utils/availability';
import {
  addDays,
  addMonths,
  isISODate,
  isNightOf,
  monthGrid,
  monthsAndDays,
  nightsBetween,
  nightsWithin,
  rangesOverlap,
  todayInZone,
  zonedTimeOf,
  zonedTimeToInstant,
} from '../utils/dates';
import { AppError, toAppError } from '../utils/errors';
import { allocateByNights, allocateToInstallments, buildYearReport } from '../utils/finance';
import { describeDeadline, formatDate, formatDateTime, formatMoney, formatMonthYear, formatTime, weekdayNames } from '../utils/format';
import { fromCents, parseMoney, splitEvenly, sumCents } from '../utils/money';
import { findPossibleDuplicates, matchesContact, telHref, toInternational, whatsappHref } from '../utils/phone';
import { pricePerNight, proposeMonthlySchedule, suggestTotal } from '../utils/pricing';

describe('stay dates (half-open intervals)', () => {
  it('counts nights and never counts the check-out day', () => {
    expect(process.env.TZ).toBe('America/New_York');
    expect(nightsBetween('2027-07-15', '2027-07-22')).toBe(7);
    expect(isNightOf('2027-07-15', '2027-07-15', '2027-07-22')).toBe(true);
    expect(isNightOf('2027-07-21', '2027-07-15', '2027-07-22')).toBe(true);
    expect(isNightOf('2027-07-22', '2027-07-15', '2027-07-22')).toBe(false);
  });

  it('treats back-to-back stays as non-overlapping', () => {
    expect(rangesOverlap('2027-07-15', '2027-07-22', '2027-07-22', '2027-07-29')).toBe(false);
    expect(rangesOverlap('2027-07-15', '2027-07-22', '2027-07-21', '2027-07-29')).toBe(true);
    expect(rangesOverlap('2027-07-15', '2027-07-22', '2027-07-01', '2027-07-15')).toBe(false);
  });

  it('counts nights correctly across daylight-saving changes and year ends', () => {
    expect(nightsBetween('2027-03-27', '2027-03-29')).toBe(2); // spring forward in Madrid
    expect(nightsBetween('2027-10-30', '2027-11-01')).toBe(2); // fall back in Madrid
    expect(nightsBetween('2027-03-13', '2027-03-15')).toBe(2); // spring forward in New York (device zone)
    expect(nightsBetween('2027-09-01', '2028-07-01')).toBe(304); // 2028 is a leap year
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(nightsWithin('2027-12-28', '2028-01-04', '2028-01-01', '2029-01-01')).toBe(3);
  });

  it('adds months by the calendar and splits stays into months and days', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-09-01', 10)).toBe('2028-07-01');
    expect(monthsAndDays('2027-09-01', '2028-07-01')).toMatchObject({ months: 10, days: 0 });
    expect(monthsAndDays('2027-01-15', '2027-03-20')).toMatchObject({ months: 2, days: 5 });
  });

  it('validates ISO dates', () => {
    expect(isISODate('2027-02-28')).toBe(true);
    expect(isISODate('2027-02-30')).toBe(false);
    expect(isISODate('28/02/2027')).toBe(false);
  });

  it('builds Monday-first month grids', () => {
    const july = monthGrid(2027, 7); // 1 July 2027 is a Thursday
    expect(july[0]).toEqual([null, null, null, '2027-07-01', '2027-07-02', '2027-07-03', '2027-07-04']);
    expect(july.every((week) => week.length === 7)).toBe(true);
    expect(monthGrid(2027, 2).flat().filter(Boolean)).toHaveLength(28);
    expect(weekdayNames('es-ES')[0].toLowerCase()).toContain('lun');
    expect(weekdayNames('en-GB')[0]).toBe('Mon');
  });
});

describe('Madrid time, whatever the device time zone', () => {
  it('converts a Madrid wall-clock time to the right instant on both sides of DST', () => {
    expect(zonedTimeToInstant('2027-07-16', '20:00').toISOString()).toBe('2027-07-16T18:00:00.000Z'); // CEST
    expect(zonedTimeToInstant('2027-01-16', '20:00').toISOString()).toBe('2027-01-16T19:00:00.000Z'); // CET
    expect(zonedTimeToInstant('2027-03-28', '16:00').toISOString()).toBe('2027-03-28T14:00:00.000Z'); // day of change
    expect(zonedTimeToInstant('2027-10-31', '16:00').toISOString()).toBe('2027-10-31T15:00:00.000Z'); // day of change
    expect(zonedTimeToInstant('2027-03-28', '01:30').toISOString()).toBe('2027-03-28T00:30:00.000Z'); // before the jump
    expect(zonedTimeToInstant('2027-03-28', '02:30').toISOString()).toBe('2027-03-28T01:30:00.000Z'); // skipped hour -> 03:30
    expect(zonedTimeToInstant('2027-10-31', '02:30').toISOString()).toBe('2027-10-31T00:30:00.000Z'); // ambiguous -> first
    expect(zonedTimeToInstant('2027-07-16', '12:00', 'Atlantic/Canary').toISOString()).toBe('2027-07-16T11:00:00.000Z');
  });

  it('knows what day it is in Madrid when the device is on another day', () => {
    // 22:30 UTC is 18:30 in New York (still the 14th) but 00:30 on the 15th in Madrid.
    const instant = new Date('2027-07-14T22:30:00Z');
    expect(instant.getDate()).toBe(14);
    expect(todayInZone('Europe/Madrid', instant)).toBe('2027-07-15');
    expect(zonedTimeOf(instant)).toBe('00:30');
  });

  it('formats instants in Madrid time with a 24-hour clock in both languages', () => {
    const deadline = new Date('2027-07-16T18:00:00Z');
    expect(formatTime(deadline, 'es-ES')).toBe('20:00');
    expect(formatTime(deadline, 'en-GB')).toBe('20:00');
    expect(formatDateTime(deadline, 'en-GB')).toBe('16/07/2027, 20:00');
    expect(formatDateTime(deadline, 'es-ES')).toMatch(/^16\/07\/2027,? 20:00$/);
  });

  it('describes a deadline as today / tomorrow / a date relative to Madrid', () => {
    const now = new Date('2027-07-15T09:00:00Z');
    expect(describeDeadline('2027-07-16T18:00:00Z', 'es-ES', 'Europe/Madrid', now)).toEqual({ kind: 'tomorrow', time: '20:00', date: '16/07/2027' });
    expect(describeDeadline('2027-07-15T18:00:00Z', 'en-GB', 'Europe/Madrid', now).kind).toBe('today');
    expect(describeDeadline('2027-07-20T18:00:00Z', 'en-GB', 'Europe/Madrid', now)).toMatchObject({ kind: 'date', date: '20/07/2027' });
    // 23:30 UTC on the 15th is already the 16th in Madrid: "tomorrow" from Madrid's 15th.
    expect(describeDeadline('2027-07-15T23:30:00Z', 'es-ES', 'Europe/Madrid', now).kind).toBe('tomorrow');
  });
});

describe('formatting', () => {
  it('formats euros for each locale', () => {
    expect(formatMoney(700, 'en-GB')).toBe('€700.00');
    expect(formatMoney(5500, 'en-GB')).toBe('€5,500.00');
    expect(formatMoney(550.5, 'es-ES').replace(/\s/g, ' ')).toBe('550,50 €');
    expect(formatMoney(-50, 'en-GB')).toBe('-€50.00');
    expect(formatMoney(null, 'es-ES')).toBe('—');
  });

  it('formats dates day/month/year with localized month names', () => {
    expect(formatDate('2027-07-15', 'es-ES')).toBe('15/07/2027');
    expect(formatDate('2027-07-15', 'en-GB')).toBe('15/07/2027');
    expect(formatDate('2027-01-01', 'en-GB')).toBe('01/01/2027'); // not shifted to 31 Dec by the device zone
    expect(formatMonthYear(2027, 7, 'es-ES')).toBe('Julio de 2027');
    expect(formatMonthYear(2027, 7, 'en-GB')).toBe('July 2027');
  });
});

describe('money', () => {
  it('parses what people type', () => {
    expect(parseMoney('700')).toBe(700);
    expect(parseMoney('550,50')).toBe(550.5);
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('1,234.56')).toBe(1234.56);
    expect(parseMoney('550 €')).toBe(550);
    expect(parseMoney('10.005')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });

  it('adds in cents, without floating-point drift', () => {
    expect(fromCents(sumCents([0.1, 0.2]))).toBe(0.3);
    expect(fromCents(sumCents(Array.from({ length: 10 }, () => 550)))).toBe(5500);
    expect(splitEvenly(1000, 3)).toEqual([333.33, 333.33, 333.34]);
  });
});

describe('pricing', () => {
  it('summer week: 15-22 July is seven nights; a weekly rate maps exactly', () => {
    expect(suggestTotal('per_week', 700, '2027-07-15', '2027-07-22')).toMatchObject({ total: 700, exact: true, nights: 7, units: 1 });
    expect(suggestTotal('per_night', 100, '2027-07-15', '2027-07-22')).toMatchObject({ total: 700, exact: true });
    expect(pricePerNight(700, 7)).toBe(100);
  });

  it('winter rental: 1 Sep - 1 Jul is ten full months at EUR 550 = EUR 5,500', () => {
    expect(suggestTotal('per_month', 550, '2027-09-01', '2028-07-01')).toMatchObject({ total: 5500, exact: true, units: 10, extraNights: 0 });
  });

  it('flags incomplete weeks and months instead of assuming anything', () => {
    const tenNights = suggestTotal('per_week', 700, '2027-07-15', '2027-07-25');
    expect(tenNights).toMatchObject({ exact: false, units: 1, extraNights: 3, total: 1000 });
    // 15 Jan -> 20 Mar: two months + 5 nights of March (31 days), never a 30-day month.
    const partial = suggestTotal('per_month', 620, '2027-01-15', '2027-03-20');
    expect(partial).toMatchObject({ exact: false, units: 2, extraNights: 5, total: 1340 });
    expect(suggestTotal('total', null, '2027-07-15', '2027-07-22').total).toBeNull();
  });

  it('proposes ten monthly instalments of EUR 550 from September to June', () => {
    const schedule = proposeMonthlySchedule('2027-09-01', '2028-07-01', 5500, 550);
    expect(schedule).toHaveLength(10);
    expect(schedule[0]).toMatchObject({ due_date: '2027-09-01', amount: 550 });
    expect(schedule[9]).toMatchObject({ due_date: '2028-06-01', amount: 550 });
    expect(fromCents(sumCents(schedule.map((s) => s.amount)))).toBe(5500);
    // Without a monthly rate the total is split and still adds up.
    const split = proposeMonthlySchedule('2027-09-01', '2027-12-01', 1000, null);
    expect(split.map((s) => s.amount)).toEqual([333.33, 333.33, 333.34]);
  });
});

describe('financial reporting', () => {
  const booking = (over: Partial<Parameters<typeof buildYearReport>[0][number]>) => ({
    property_id: 'p1', start_date: '2027-07-15', end_date: '2027-07-22', total_price: 700, status: 'confirmed', outstanding: 500, overdue: 0, ...over,
  });
  const payment = (over: Partial<Parameters<typeof buildYearReport>[1][number]>) => ({
    property_id: 'p1', payment_date: '2027-06-01', payment_type: 'deposit', amount: 200, voided_at: null, ...over,
  });

  it('splits a stay that crosses years by nights, to the cent', () => {
    const y2027 = allocateByNights(5500, '2027-09-01', '2028-07-01', '2027-01-01', '2028-01-01');
    const y2028 = allocateByNights(5500, '2027-09-01', '2028-07-01', '2028-01-01', '2029-01-01');
    expect(y2027).toBe(2207.24); // 122 of 304 nights
    expect(fromCents(sumCents([y2027, y2028]))).toBe(5500);
  });

  it('keeps booking value, cash and outstanding apart', () => {
    const bookings = [
      booking({}),
      booking({ start_date: '2027-09-01', end_date: '2028-07-01', total_price: 5500, outstanding: 4950, overdue: 550 }),
      booking({ start_date: '2027-08-01', end_date: '2027-08-08', status: 'cancelled', total_price: 900, outstanding: 0 }),
      booking({ start_date: '2027-05-01', end_date: '2027-05-08', status: 'completed', total_price: 600, outstanding: 0 }),
      booking({ start_date: '2027-06-01', end_date: '2027-06-08', status: 'provisional', total_price: 400, outstanding: 400 }),
    ];
    const payments = [
      payment({}),
      payment({ payment_date: '2027-08-05', payment_type: 'refund', amount: 50 }),
      payment({ payment_date: '2027-08-06', amount: 999, voided_at: '2027-08-07T10:00:00Z' }),
      payment({ payment_date: '2028-01-05', amount: 550 }),
      payment({ payment_date: '2027-04-10', amount: 600, payment_type: 'final_payment' }),
    ];
    const r2027 = buildYearReport(bookings, payments, 2027, 1);
    expect(r2027).toMatchObject({
      agreedValue: 700 + 2207.24 + 600, // cancelled and provisional excluded
      bookingsCount: 3,
      occupiedNights: 7 + 122 + 7,
      availableNights: 365,
      receipts: 800,
      refunds: 50,
      netReceipts: 750, // voided payment ignored; January 2028 payment belongs to 2028
      outstanding: 5450,
      overdue: 550,
    });
    expect(r2027.occupancy).toBeCloseTo(136 / 365);
    expect(r2027.monthlyNet[5]).toBe(200);
    expect(r2027.monthlyNet[7]).toBe(-50);
    const r2028 = buildYearReport(bookings, payments, 2028, 1);
    expect(r2028).toMatchObject({ agreedValue: 3292.76, occupiedNights: 182, availableNights: 366, netReceipts: 550, bookingsCount: 1 });
    // Two properties double the denominator.
    expect(buildYearReport(bookings, payments, 2027, 2).availableNights).toBe(730);
  });

  it('applies receipts to the oldest instalments first and never marks future ones overdue', () => {
    const items = proposeMonthlySchedule('2027-09-01', '2028-07-01', 5500, 550).map((s, i) => ({ id: String(i), ...s }));
    const rows = allocateToInstallments(items, 750, '2027-11-15');
    expect(rows.map((r) => r.state)).toEqual(['paid', 'overdue', 'overdue', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(rows[1]).toMatchObject({ covered: 200, pending: 350 });
    expect(allocateToInstallments(items, 0, '2027-08-01').every((r) => r.state === 'upcoming')).toBe(true);
    expect(allocateToInstallments(items, 550, '2027-09-01')[0].state).toBe('paid');
    expect(allocateToInstallments(items, 0, '2027-09-01')[0].state).toBe('due_today');
  });
});

describe('contacts', () => {
  const contacts = [
    { id: '1', full_name: 'María Demo', phone: '+34 600 11 22 33', email: 'maria@example.test' },
    { id: '2', full_name: 'Juan Muestra', phone: null, email: null },
  ];

  it('normalizes phone numbers only when it is safe to', () => {
    expect(toInternational('600 11 22 33')).toBe('+34600112233');
    expect(toInternational('+44 7700 900000')).toBe('+447700900000');
    expect(toInternational('0034 600112233')).toBe('+34600112233');
    expect(toInternational('12345')).toBeNull();
    expect(whatsappHref('600 11 22 33')).toBe('https://wa.me/34600112233');
    expect(whatsappHref('12345')).toBeNull();
    expect(telHref('600 11 22 33')).toBe('tel:+34600112233');
    expect(telHref(null)).toBeNull();
  });

  it('searches by accent-insensitive name, phone digits and e-mail', () => {
    expect(matchesContact(contacts[0], 'maria')).toBe(true);
    expect(matchesContact(contacts[0], '600112')).toBe(true);
    expect(matchesContact(contacts[0], 'MARIA@example')).toBe(true);
    expect(matchesContact(contacts[1], '600')).toBe(false);
  });

  it('warns about likely duplicates without blocking different people', () => {
    expect(findPossibleDuplicates(contacts, { full_name: 'maria demo' })).toHaveLength(1);
    expect(findPossibleDuplicates(contacts, { full_name: 'Otra Persona', phone: '600112233' })).toHaveLength(1);
    expect(findPossibleDuplicates(contacts, { full_name: 'María Otra' })).toHaveLength(0);
    expect(findPossibleDuplicates(contacts, { id: '1', full_name: 'María Demo' })).toHaveLength(0);
  });
});

describe('availability and calendar', () => {
  const blocking: Blocking[] = [
    { id: 'a', workspace_id: 'w', property_id: 'p1', kind: 'booking', hold_id: null, booking_id: 'b1', start_date: '2027-07-15', end_date: '2027-07-22', guest_name: 'Ana', booking_status: 'confirmed', expires_at: null, candidate_id: null },
    { id: 'b', workspace_id: 'w', property_id: 'p1', kind: 'hold', hold_id: 'h1', booking_id: null, start_date: '2027-07-22', end_date: '2027-07-29', guest_name: 'María', booking_status: null, expires_at: '2027-07-01T18:00:00Z', candidate_id: 'c1' },
    { id: 'c', workspace_id: 'w', property_id: 'p2', kind: 'booking', hold_id: null, booking_id: 'b2', start_date: '2027-07-01', end_date: '2027-08-01', guest_name: 'Otro', booking_status: 'completed', expires_at: null, candidate_id: null },
  ];
  const periods = [{ id: 'per1', property_id: 'p1', start_date: '2027-07-20', end_date: '2027-07-27', status: 'open' }] as Period[];
  const candidates = [
    { id: 'c1', booking_period_id: 'per1', status: 'undecided' },
    { id: 'c2', booking_period_id: 'per1', status: 'interested' },
    { id: 'c3', booking_period_id: 'per1', status: 'discarded' },
  ] as Candidate[];

  it('reports free / held / booked per property', () => {
    expect(availabilityFor(blocking, 'p1', '2027-07-08', '2027-07-15').state).toBe('free'); // ends on check-in day
    expect(availabilityFor(blocking, 'p1', '2027-07-21', '2027-07-23').state).toBe('booked');
    expect(availabilityFor(blocking, 'p1', '2027-07-22', '2027-07-29').state).toBe('held');
    expect(availabilityFor(blocking, 'p1', '2027-07-29', '2027-08-05').state).toBe('free');
    expect(availabilityFor(blocking, 'p3', '2027-07-15', '2027-07-22').state).toBe('free');
  });

  it('describes calendar days, keeping check-out distinct from occupied nights', () => {
    const day = (d: string) => describeDay(d, 'p1', blocking, periods, candidates);
    expect(day('2027-07-15')).toMatchObject({ state: 'booked', isCheckIn: true, checkout: null });
    expect(day('2027-07-21')).toMatchObject({ state: 'booked', candidateCount: 2 });
    // 22 July: Ana checks out, María's hold starts.
    expect(day('2027-07-22').state).toBe('held');
    expect(day('2027-07-22').checkout?.guest_name).toBe('Ana');
    // 29 July: hold checks out, the night itself is free.
    expect(day('2027-07-29')).toMatchObject({ state: 'free', candidateCount: 0 });
    expect(day('2027-07-29').checkout?.guest_name).toBe('María');
    expect(describeDay('2027-07-10', 'p2', blocking, periods, candidates).state).toBe('completed');
  });
});

describe('error mapping', () => {
  it('turns backend errors into stable codes', () => {
    const held = toAppError({ message: 'DATES_HELD', code: 'P0001', details: '{"guest_name":"María","expires_at":"2027-07-16T18:00:00Z"}' });
    expect(held).toBeInstanceOf(AppError);
    expect(held.code).toBe('DATES_HELD');
    expect(held.detail.guest_name).toBe('María');
    expect(toAppError({ code: '23P01', message: 'conflicting key value violates exclusion constraint' }).code).toBe('DATES_UNAVAILABLE');
    expect(toAppError({ code: '42501', message: 'permission denied' }).code).toBe('FORBIDDEN');
    expect(toAppError({ code: '23505', message: 'duplicate key' }).code).toBe('DUPLICATE');
    expect(toAppError(new TypeError('Failed to fetch')).code).toBe('NETWORK');
    expect(toAppError({ message: 'Invalid login credentials' }).code).toBe('INVALID_CREDENTIALS');
    expect(toAppError({ message: 'something odd' }).code).toBe('UNKNOWN');
  });
});

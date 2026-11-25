// Calendar-date helpers.
//
// Stay dates are plain 'YYYY-MM-DD' strings and are never converted through the device's
// local time zone: all arithmetic happens in UTC, so a phone set to New York or Tokyo shows
// exactly the same nights. Instants (hold deadlines, audit timestamps) are real Date objects
// and are displayed in the property's time zone (Europe/Madrid by default).

export type ISODate = string; // 'YYYY-MM-DD'

export const DEFAULT_TIME_ZONE = 'Europe/Madrid';

const pad = (n: number) => String(n).padStart(2, '0');

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = toUTC(value);
  return !Number.isNaN(d.getTime()) && fromUTC(d) === value;
}

export function toUTC(date: ISODate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromUTC(date: Date): ISODate {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function makeDate(year: number, month1: number, day: number): ISODate {
  return fromUTC(new Date(Date.UTC(year, month1 - 1, day)));
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTC(d);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Adds calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: ISODate, months: number): ISODate {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return makeDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Whole days from a to b (b - a). For a stay this is the number of nights. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000);
}

export const nightsBetween = (checkIn: ISODate, checkOut: ISODate) => diffDays(checkIn, checkOut);

/** Half-open overlap test: [aStart, aEnd) and [bStart, bEnd). Touching ranges do not overlap. */
export function rangesOverlap(aStart: ISODate, aEnd: ISODate, bStart: ISODate, bEnd: ISODate): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** True when `day` is an occupied night of the stay (the check-out day is not). */
export function isNightOf(day: ISODate, checkIn: ISODate, checkOut: ISODate): boolean {
  return day >= checkIn && day < checkOut;
}

/** Number of nights of [start, end) that fall inside [from, to). */
export function nightsWithin(start: ISODate, end: ISODate, from: ISODate, to: ISODate): number {
  const s = start > from ? start : from;
  const e = end < to ? end : to;
  return s < e ? diffDays(s, e) : 0;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock components of an instant in a time zone. */
export function zonedParts(instant: Date, timeZone = DEFAULT_TIME_ZONE): ZonedParts {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

/** The calendar date it currently is in the given time zone. */
export function todayInZone(timeZone = DEFAULT_TIME_ZONE, now: Date = new Date()): ISODate {
  const p = zonedParts(now, timeZone);
  return makeDate(p.year, p.month, p.day);
}

export function zonedDateOf(instant: Date, timeZone = DEFAULT_TIME_ZONE): ISODate {
  return todayInZone(timeZone, instant);
}

export function zonedTimeOf(instant: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Converts a wall-clock date and time in a time zone to the instant it denotes,
 * independently of the device time zone and across daylight-saving changes.
 * A time skipped by the spring change (02:30 on the last Sunday of March in Madrid) resolves
 * to the instant one hour later; an ambiguous autumn time resolves to the first occurrence.
 */
export function zonedTimeToInstant(date: ISODate, time: string, timeZone = DEFAULT_TIME_ZONE): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetAt = (ts: number) => {
    const p = zonedParts(new Date(ts), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts;
  };
  // The zone's offset a day before and a day after covers both sides of any DST change.
  const day = 86400000;
  const before = offsetAt(wanted - day);
  const after = offsetAt(wanted + day);
  const candidates = [...new Set([wanted - before, wanted - after])].sort((a, b) => a - b);
  for (const ts of candidates) {
    if (ts + offsetAt(ts) === wanted) return new Date(ts);
  }
  // The wall-clock time does not exist (spring gap): continue with the pre-change offset.
  return new Date(wanted - before);
}

/** Monday-first weeks covering a month: each cell is a date or null for padding. */
export function monthGrid(year: number, month1: number): (ISODate | null)[][] {
  const first = toUTC(makeDate(year, month1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const total = daysInMonth(year, month1);
  const cells: (ISODate | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= total; day++) cells.push(makeDate(year, month1, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (ISODate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * Splits a stay into whole calendar months plus leftover nights.
 * 1 Sep -> 1 Jul is 10 months and 0 nights; 15 Jan -> 20 Mar is 2 months and 5 nights.
 */
export function monthsAndDays(start: ISODate, end: ISODate): { months: number; days: number; remainderStart: ISODate } {
  let months = 0;
  while (addMonths(start, months + 1) <= end) months++;
  const remainderStart = addMonths(start, months);
  return { months, days: diffDays(remainderStart, end), remainderStart };
}

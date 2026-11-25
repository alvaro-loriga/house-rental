import { DEFAULT_TIME_ZONE, diffDays, toUTC, todayInZone, zonedDateOf, type ISODate } from './dates';

export type AppLocale = 'es-ES' | 'en-GB';
export const LOCALES: AppLocale[] = ['es-ES', 'en-GB'];

export const toLocale = (language: string | undefined): AppLocale => (language?.startsWith('en') ? 'en-GB' : 'es-ES');

export function formatMoney(amount: number | null | undefined, locale: AppLocale): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(amount);
}

export function formatPercent(ratio: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
}

/** 15/07/2027 in both locales. */
export function formatDate(date: ISODate | null | undefined, locale: AppLocale): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(toUTC(date));
}

/** "jue, 15 jul 2027" / "Thu, 15 Jul 2027". */
export function formatDateLong(date: ISODate, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(
    toUTC(date),
  );
}

export function formatDateRange(start: ISODate, end: ISODate, locale: AppLocale): string {
  return `${formatDate(start, locale)} – ${formatDate(end, locale)}`;
}

export function formatMonthYear(year: number, month1: number, locale: AppLocale): string {
  const text = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month1 - 1, 1)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function monthName(month1: number, locale: AppLocale, style: 'long' | 'short' = 'long'): string {
  const text = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: style }).format(new Date(Date.UTC(2024, month1 - 1, 1)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Monday-first short weekday names. */
export function weekdayNames(locale: AppLocale): string[] {
  const f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' });
  // 1 January 2024 was a Monday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/** Time of day, always 24-hour, in the property's time zone. */
export function formatTime(instant: Date | string, locale: AppLocale, timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

export function formatDateTime(instant: Date | string | null | undefined, locale: AppLocale, timeZone = DEFAULT_TIME_ZONE): string {
  if (!instant) return '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

export type DeadlineKind = 'today' | 'tomorrow' | 'date';

/**
 * How to phrase a deadline relative to "today" in the property's time zone:
 * "today at 20:00", "tomorrow at 20:00" or "on 17/07/2027 at 20:00".
 */
export function describeDeadline(instant: Date | string, locale: AppLocale, timeZone = DEFAULT_TIME_ZONE, now: Date = new Date()) {
  const date = new Date(instant);
  const day = zonedDateOf(date, timeZone);
  const delta = diffDays(todayInZone(timeZone, now), day);
  const kind: DeadlineKind = delta === 0 ? 'today' : delta === 1 ? 'tomorrow' : 'date';
  return { kind, time: formatTime(date, locale, timeZone), date: formatDate(day, locale) };
}

/** Whole minutes left until an instant (negative once it has passed). */
export function minutesUntil(instant: Date | string, now: Date = new Date()): number {
  return Math.floor((new Date(instant).getTime() - now.getTime()) / 60000);
}

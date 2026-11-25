import { addMonths, daysInMonth, monthsAndDays, nightsBetween, type ISODate } from './dates';
import { fromCents, splitEvenly, toCents } from './money';

export type PricingType = 'total' | 'per_night' | 'per_week' | 'per_month';
export const PRICING_TYPES: PricingType[] = ['total', 'per_night', 'per_week', 'per_month'];

export interface PriceSuggestion {
  /** Proposed total, or null when nothing can be proposed. */
  total: number | null;
  /**
   * true  - the rate maps cleanly onto the stay (whole nights / weeks / calendar months).
   * false - the stay has an incomplete week or month. The proposal is pro-rata and the
   *         person must type the agreed total explicitly; it is never applied silently.
   */
  exact: boolean;
  nights: number;
  /** Whole units (weeks or months) and leftover nights used for the proposal. */
  units: number;
  extraNights: number;
}

/**
 * Pricing rules
 *  - per_night: nights x rate. Always exact.
 *  - per_week:  exact when the stay is a multiple of 7 nights. Otherwise the proposal is
 *               whole weeks x rate + leftover nights x rate / 7.
 *  - per_month: exact when check-in and check-out fall on the same day of the month
 *               (1 Sep -> 1 Jul = 10 months). Otherwise the proposal is whole months x rate +
 *               leftover nights x rate / (days in the calendar month where the leftover starts).
 *               No 30-day month is ever assumed.
 *  - total:     nothing to compute.
 */
export function suggestTotal(type: PricingType, unitPrice: number | null, start: ISODate, end: ISODate): PriceSuggestion {
  const nights = start && end && end > start ? nightsBetween(start, end) : 0;
  const none: PriceSuggestion = { total: null, exact: true, nights, units: 0, extraNights: 0 };
  if (type === 'total' || unitPrice == null || nights <= 0) return none;
  const rate = toCents(unitPrice);

  if (type === 'per_night') {
    return { total: fromCents(rate * nights), exact: true, nights, units: nights, extraNights: 0 };
  }
  if (type === 'per_week') {
    const weeks = Math.floor(nights / 7);
    const extra = nights % 7;
    const cents = rate * weeks + Math.round((rate * extra) / 7);
    return { total: fromCents(cents), exact: extra === 0, nights, units: weeks, extraNights: extra };
  }
  const { months, days, remainderStart } = monthsAndDays(start, end);
  const [y, m] = remainderStart.split('-').map(Number);
  const cents = rate * months + Math.round((rate * days) / daysInMonth(y, m));
  return { total: fromCents(cents), exact: days === 0, nights, units: months, extraNights: days };
}

export interface ProposedInstallment {
  due_date: ISODate;
  amount: number;
  description: string;
}

/**
 * Proposes one instalment per month of the stay, due on the check-in day of each month
 * (1 Sep -> 1 Jul gives ten instalments, September to June).
 * With a monthly rate each instalment is that rate; otherwise the total is split evenly and
 * the last instalment absorbs the rounding. The caller shows any difference to the agreed total.
 */
export function proposeMonthlySchedule(start: ISODate, end: ISODate, total: number, monthlyRate: number | null): ProposedInstallment[] {
  const dates: ISODate[] = [];
  for (let i = 0; addMonths(start, i) < end; i++) dates.push(addMonths(start, i));
  if (dates.length === 0) return [];
  const amounts = monthlyRate != null && monthlyRate > 0 ? dates.map(() => monthlyRate) : splitEvenly(total, dates.length);
  return dates
    .map((due_date, i) => ({ due_date, amount: amounts[i], description: `${i + 1}/${dates.length}` }))
    .filter((item) => item.amount > 0);
}

export const pricePerNight = (total: number, nights: number): number | null =>
  nights > 0 ? fromCents(Math.round(toCents(total) / nights)) : null;

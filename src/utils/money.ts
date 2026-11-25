// Money helpers. Amounts travel as JSON numbers with two decimals (PostgreSQL numeric(12,2));
// every calculation in the browser is done in integer cents to avoid floating-point drift.
// The database remains the authority for balances.

export const toCents = (amount: number | null | undefined): number => Math.round((amount ?? 0) * 100);
export const fromCents = (cents: number): number => Math.round(cents) / 100;

export const sumCents = (amounts: (number | null | undefined)[]): number =>
  amounts.reduce<number>((total, a) => total + toCents(a), 0);

/**
 * Parses what a person types: "700", "700,50", "1.234,56", "1,234.56", "550 €".
 * Returns null when it is not a valid non-negative amount with at most two decimals.
 */
export function parseMoney(input: string): number | null {
  let s = input.replace(/[\s€]|EUR/gi, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // The right-most separator is the decimal one; the other groups thousands.
    const decimal = lastComma > lastDot ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    s = s.split(group).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const value = Number(s);
  return Number.isFinite(value) && value < 1e10 ? value : null;
}

/** Splits a total into n parts that add up exactly; the last part absorbs the rounding. */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const cents = toCents(total);
  const base = Math.floor(cents / parts);
  const out = Array.from({ length: parts }, () => base);
  out[parts - 1] += cents - base * parts;
  return out.map(fromCents);
}

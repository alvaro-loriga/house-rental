import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PriceFields, StayFields, emptyPrice, parsePrice, validateStay, type PriceDraft } from '../components/forms';
import i18n, { LANGUAGE_STORAGE_KEY, applyLocale, storedLocale } from '../lib/i18n';
import en from '../locales/en.json';
import es from '../locales/es.json';
import { BOOKING_STATUSES, CANDIDATE_STATUSES, PAYMENT_METHODS, PAYMENT_TYPES } from '../types/database';
import { KNOWN_ERROR_CODES } from '../utils/errors';
import { PRICING_TYPES } from '../utils/pricing';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[full] = value;
    else Object.assign(out, flatten(value, full));
  }
  return out;
}

const esFlat = flatten(es as Tree);
const enFlat = flatten(en as Tree);
const has = (flat: Record<string, string>, key: string) => key in flat || `${key}_one` in flat || `${key}_other` in flat;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'locales' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

afterEach(async () => {
  await applyLocale('es-ES');
});

describe('dictionaries', () => {
  it('have exactly the same keys in Spanish and English', () => {
    expect(Object.keys(enFlat).sort()).toEqual(Object.keys(esFlat).sort());
  });

  it('use the same interpolation variables in both languages', () => {
    const vars = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort().join(',');
    for (const key of Object.keys(esFlat)) expect(vars(enFlat[key]), key).toBe(vars(esFlat[key]));
  });

  it('contain every literal key the source code asks for', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(path.resolve(__dirname, '..'))) {
      const text = fs.readFileSync(file, 'utf8');
      // t('a.b.c'...) and string literals that are clearly keys ('validation.x', 'errors.X').
      const keys = [
        ...[...text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]),
        ...[...text.matchAll(/'((?:validation|errors|holds|installments|availability)\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]),
      ];
      for (const key of keys) if (!has(esFlat, key) || !has(enFlat, key)) missing.push(`${path.basename(file)}: ${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('translate every stable identifier used by the database', () => {
    const required = [
      ...KNOWN_ERROR_CODES.map((c) => `errors.${c}`),
      ...CANDIDATE_STATUSES.map((s) => `status.candidate.${s}`),
      ...BOOKING_STATUSES.map((s) => `status.booking.${s}`),
      ...['active', 'released', 'expired', 'converted'].map((s) => `status.hold.${s}`),
      ...['open', 'booked', 'closed', 'cancelled'].map((s) => `status.period.${s}`),
      ...['unpaid', 'partially_paid', 'paid', 'overpaid'].map((s) => `status.payment.${s}`),
      ...PAYMENT_TYPES.map((s) => `paymentType.${s}`),
      ...PAYMENT_METHODS.map((s) => `paymentMethod.${s}`),
      ...PRICING_TYPES.map((s) => `pricingType.${s}`),
      ...['created', 'extended', 'released', 'expired', 'overridden', 'converted'].map((s) => `audit.hold.${s}`),
      ...['created', 'corrected', 'voided'].map((s) => `audit.payment.${s}`),
      ...['created', 'confirmed', 'updated', 'cancelled', 'completed', 'reopened'].map((s) => `audit.booking.${s}`),
      ...['dashboard', 'calendar', 'bookings', 'prospects', 'payments', 'guests', 'reports', 'settings'].map((s) => `nav.${s}`),
    ];
    for (const key of required) {
      expect(esFlat[key], `es ${key}`).toBeTruthy();
      expect(enFlat[key], `en ${key}`).toBeTruthy();
    }
  });

  it('match the agreed vocabulary', () => {
    const pairs: [string, string, string][] = [
      ['nav.dashboard', 'Inicio', 'Dashboard'],
      ['nav.bookings', 'Reservas', 'Bookings'],
      ['nav.prospects', 'Interesados', 'Prospects'],
      ['nav.guests', 'Huéspedes', 'Guests'],
      ['nav.calendar', 'Calendario', 'Calendar'],
      ['nav.payments', 'Pagos', 'Payments'],
      ['status.candidate.interested', 'Interesado', 'Interested'],
      ['status.candidate.undecided', 'Dudoso', 'Undecided'],
      ['status.candidate.awaiting_response', 'Esperando respuesta', 'Awaiting response'],
      ['status.hold.active', 'Bloqueo temporal', 'Temporary hold'],
      ['status.candidate.confirmed', 'Confirmado', 'Confirmed'],
      ['status.candidate.discarded', 'Descartado', 'Discarded'],
      ['common.paid', 'Pagado', 'Paid'],
      ['common.outstanding', 'Pendiente de cobro', 'Outstanding'],
      ['holds.expiry', 'Vencimiento del bloqueo', 'Hold expires'],
    ];
    for (const [key, spanish, english] of pairs) {
      expect(esFlat[key]).toBe(spanish);
      expect(enFlat[key]).toBe(english);
    }
  });

  it('phrase the hold deadline as in the brief', async () => {
    const when = (lng: string) => i18n.t('holds.deadline.tomorrow', { lng, time: '20:00' });
    expect(i18n.t('holds.expiresAt', { lng: 'es-ES', when: when('es-ES') })).toBe('Vence mañana a las 20:00');
    expect(i18n.t('holds.expiresAt', { lng: 'en-GB', when: when('en-GB') })).toBe('Expires tomorrow at 20:00');
    expect(i18n.t('common.nights', { lng: 'es-ES', count: 1 })).toBe('1 noche');
    expect(i18n.t('common.nights', { lng: 'en-GB', count: 7 })).toBe('7 nights');
  });
});

function BookingFormHarness() {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [price, setPrice] = useState<PriceDraft>(emptyPrice());
  const [submitted, setSubmitted] = useState(false);
  const stayError = validateStay(start, end);
  const parsed = parsePrice(price);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <StayFields start={start} end={end} onChange={(s, e) => (setStart(s), setEnd(e))} error={submitted && stayError ? i18n.t(stayError) : null} />
      <PriceFields draft={price} onChange={setPrice} start="" end="" error={submitted && parsed.error ? i18n.t(parsed.error) : null} />
      <button type="submit">submit</button>
    </form>
  );
}

describe('switching language', () => {
  it('defaults to Spanish, updates in place, keeps form input and remembers the choice', async () => {
    const user = userEvent.setup();
    expect(storedLocale()).toBe('es-ES');
    const view = render(<BookingFormHarness />);
    const total = screen.getByLabelText('Precio total acordado');
    await user.type(total, '700');
    await user.type(screen.getByLabelText('Entrada'), '2027-07-15');

    await applyLocale('en-GB');
    view.rerender(<BookingFormHarness />);
    // Same DOM node, same value: nothing was remounted or navigated.
    expect(screen.getByLabelText('Agreed total price')).toBe(total);
    expect(total).toHaveValue('700');
    expect(screen.getByLabelText('Check-in')).toHaveValue('2027-07-15');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en-GB');
    expect(storedLocale()).toBe('en-GB'); // what a reload starts from
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows validation messages in the active language', async () => {
    const user = userEvent.setup();
    const view = render(<BookingFormHarness />);
    await user.click(screen.getByRole('button', { name: 'submit' }));
    expect(screen.getByText('Indica la fecha de entrada y la de salida.')).toBeInTheDocument();
    expect(screen.getByText('Indica el precio total acordado.')).toBeInTheDocument();

    await applyLocale('en-GB');
    view.rerender(<BookingFormHarness />);
    await user.click(screen.getByRole('button', { name: 'submit' }));
    expect(screen.getByText('Enter both the check-in and the check-out date.')).toBeInTheDocument();
    expect(screen.getByText('Enter the agreed total price.')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Agreed total price/), 'abc');
    await user.click(screen.getByRole('button', { name: 'submit' }));
    expect(screen.getByText(/Invalid amount/)).toBeInTheDocument();
  });
});

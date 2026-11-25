import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGuests, useLocale } from '../hooks/data';
import * as api from '../services/api';
import type { Guest } from '../types/database';
import { isISODate, nightsBetween, type ISODate } from '../utils/dates';
import { formatMoney } from '../utils/format';
import { parseMoney } from '../utils/money';
import { findPossibleDuplicates, matchesContact } from '../utils/phone';
import { PRICING_TYPES, suggestTotal, type PricingType } from '../utils/pricing';
import { Field, Notice } from './ui';

// --- Guest picker ----------------------------------------------------------------
export interface GuestChoice {
  mode: 'existing' | 'new';
  guestId: string;
  full_name: string;
  phone: string;
  email: string;
}
export const emptyGuestChoice = (guestId = ''): GuestChoice => ({ mode: guestId ? 'existing' : 'new', guestId, full_name: '', phone: '', email: '' });

export function validateGuestChoice(choice: GuestChoice): 'validation.guestRequired' | 'validation.nameRequired' | null {
  if (choice.mode === 'existing') return choice.guestId ? null : 'validation.guestRequired';
  return choice.full_name.trim() ? null : 'validation.nameRequired';
}

/** Returns the id of the chosen guest, creating the contact first when it is a new one. */
export async function resolveGuest(workspaceId: string, choice: GuestChoice): Promise<string> {
  if (choice.mode === 'existing') return choice.guestId;
  return api.createGuest(workspaceId, { full_name: choice.full_name, phone: choice.phone, email: choice.email, notes: '' });
}

/** Pick a known contact (search by name, phone or e-mail) or type a new one. */
export function GuestPicker({ value, onChange, error, exclude = [] }: { value: GuestChoice; onChange: (next: GuestChoice) => void; error?: string | null; exclude?: string[] }) {
  const { t } = useTranslation();
  const guests = useGuests();
  const [query, setQuery] = useState('');
  const available = useMemo(
    () => (guests.data ?? []).filter((g) => !g.archived_at && !exclude.includes(g.id)),
    [guests.data, exclude],
  );
  const matches = useMemo(() => available.filter((g) => matchesContact(g, query)), [available, query]);
  const duplicates = value.mode === 'new' && value.full_name.trim() ? findPossibleDuplicates(guests.data ?? [], value) : [];
  const set = (patch: Partial<GuestChoice>) => onChange({ ...value, ...patch });

  return (
    <fieldset className="fieldset">
      <legend>{t('common.guest')}</legend>
      <div className="segmented" role="radiogroup" aria-label={t('guests.pickMode')}>
        <label>
          <input type="radio" name="guest-mode" checked={value.mode === 'existing'} onChange={() => set({ mode: 'existing' })} />
          {t('guests.existing')}
        </label>
        <label>
          <input type="radio" name="guest-mode" checked={value.mode === 'new'} onChange={() => set({ mode: 'new' })} />
          {t('guests.new')}
        </label>
      </div>
      {value.mode === 'existing' ? (
        <>
          <Field label={t('common.search')}>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('guests.searchPlaceholder')} />
          </Field>
          <Field label={t('guests.choose')} error={error}>
            <select value={value.guestId} onChange={(e) => set({ guestId: e.target.value })}>
              <option value="">{t('common.choose')}</option>
              {matches.map((g: Guest) => (
                <option key={g.id} value={g.id}>
                  {g.full_name}
                  {g.phone ? ` · ${g.phone}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field label={t('common.name')} error={error}>
            <input type="text" value={value.full_name} onChange={(e) => set({ full_name: e.target.value })} autoComplete="off" />
          </Field>
          <div className="grid-2">
            <Field label={t('common.phoneOptional')}>
              <input type="tel" value={value.phone} onChange={(e) => set({ phone: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={t('common.emailOptional')}>
              <input type="email" value={value.email} onChange={(e) => set({ email: e.target.value })} autoComplete="off" />
            </Field>
          </div>
          {duplicates.length > 0 ? (
            <Notice kind="warning">
              {t('guests.duplicateWarning', { names: duplicates.map((d) => d.full_name).join(', ') })}{' '}
              <button type="button" className="link-button" onClick={() => onChange({ ...value, mode: 'existing', guestId: duplicates[0].id })}>
                {t('guests.useExisting')}
              </button>
            </Notice>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

// --- Dates -----------------------------------------------------------------------
export function validateStay(start: string, end: string): 'validation.datesRequired' | 'validation.checkoutAfterCheckin' | null {
  if (!isISODate(start) || !isISODate(end)) return 'validation.datesRequired';
  return end > start ? null : 'validation.checkoutAfterCheckin';
}

export function StayFields({ start, end, onChange, error }: { start: string; end: string; onChange: (start: string, end: string) => void; error?: string | null }) {
  const { t } = useTranslation();
  const nights = isISODate(start) && isISODate(end) && end > start ? nightsBetween(start, end) : null;
  return (
    <div>
      <div className="grid-2">
        <Field label={t('common.checkIn')}>
          <input type="date" value={start} onChange={(e) => onChange(e.target.value, end)} required />
        </Field>
        <Field label={t('common.checkOut')} hint={t('common.checkOutHint')}>
          <input type="date" value={end} min={start || undefined} onChange={(e) => onChange(start, e.target.value)} required />
        </Field>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : nights != null ? (
        <p className="field-hint">{t('common.nights', { count: nights })}</p>
      ) : null}
    </div>
  );
}

// --- Price -----------------------------------------------------------------------
export interface PriceDraft {
  pricing_type: PricingType;
  unit: string;
  total: string;
  deposit: string;
  notes: string;
}
export const emptyPrice = (total: number | null = null): PriceDraft => ({
  pricing_type: 'total',
  unit: '',
  total: total != null ? String(total) : '',
  deposit: '',
  notes: '',
});

export type PriceError = 'validation.totalRequired' | 'validation.invalidAmount';
export function parsePrice(draft: PriceDraft): { value: api.PriceInput | null; error: PriceError | null } {
  const total = parseMoney(draft.total);
  if (draft.total.trim() === '') return { value: null, error: 'validation.totalRequired' };
  const unit = draft.pricing_type === 'total' || draft.unit.trim() === '' ? null : parseMoney(draft.unit);
  const deposit = draft.deposit.trim() === '' ? 0 : parseMoney(draft.deposit);
  if (total == null || deposit == null || (draft.pricing_type !== 'total' && draft.unit.trim() !== '' && unit == null)) {
    return { value: null, error: 'validation.invalidAmount' };
  }
  return { value: { pricing_type: draft.pricing_type, unit_price: unit, total_price: total, deposit_required: deposit, notes: draft.notes }, error: null };
}

/**
 * Pricing type, rate, agreed total and deposit. A calculated total is only ever offered as a
 * button; the agreed total is what the person types or accepts.
 */
export function PriceFields({ draft, onChange, start, end, error }: { draft: PriceDraft; onChange: (next: PriceDraft) => void; start: ISODate | ''; end: ISODate | ''; error?: string | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const set = (patch: Partial<PriceDraft>) => onChange({ ...draft, ...patch });
  const unit = parseMoney(draft.unit);
  const suggestion = start && end ? suggestTotal(draft.pricing_type, unit, start, end) : null;

  return (
    <fieldset className="fieldset">
      <legend>{t('pricing.title')}</legend>
      <div className="grid-2">
        <Field label={t('pricing.type')}>
          <select value={draft.pricing_type} onChange={(e) => set({ pricing_type: e.target.value as PricingType })}>
            {PRICING_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`pricingType.${type}`)}
              </option>
            ))}
          </select>
        </Field>
        {draft.pricing_type !== 'total' ? (
          <Field label={t(`pricing.rate.${draft.pricing_type}`)}>
            <input type="text" inputMode="decimal" value={draft.unit} onChange={(e) => set({ unit: e.target.value })} />
          </Field>
        ) : null}
      </div>
      {suggestion && suggestion.total != null ? (
        <Notice kind={suggestion.exact ? 'info' : 'warning'}>
          {t(`pricing.calc.${draft.pricing_type}`, {
            count: suggestion.units,
            extra: suggestion.extraNights,
            rate: formatMoney(unit, locale),
            total: formatMoney(suggestion.total, locale),
          })}{' '}
          {suggestion.exact ? null : <>{t('pricing.ambiguous')} </>}
          <button type="button" className="link-button" onClick={() => set({ total: String(suggestion.total) })}>
            {t('pricing.useSuggestion', { total: formatMoney(suggestion.total, locale) })}
          </button>
        </Notice>
      ) : null}
      <div className="grid-2">
        <Field label={t('pricing.agreedTotal')} error={error}>
          <input type="text" inputMode="decimal" value={draft.total} onChange={(e) => set({ total: e.target.value })} />
        </Field>
        <Field label={t('pricing.deposit')} hint={t('pricing.depositHint')}>
          <input type="text" inputMode="decimal" value={draft.deposit} onChange={(e) => set({ deposit: e.target.value })} />
        </Field>
      </div>
      <Field label={t('common.notesOptional')}>
        <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </fieldset>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useApp } from '../app/AppContext';
import { useLocale } from '../hooks/data';
import * as api from '../services/api';
import type { AuditEvent } from '../types/database';
import { isISODate } from '../utils/dates';
import { formatDate, formatDateTime, formatMoney, type AppLocale } from '../utils/format';
import { Empty } from './ui';

const MONEY_FIELDS = new Set(['amount', 'total_price', 'unit_price', 'deposit_required', 'cancellation_fee']);
const ENUM_FIELDS: Record<string, string> = {
  payment_method: 'paymentMethod',
  payment_type: 'paymentType',
  pricing_type: 'pricingType',
};
const HIDDEN_FIELDS = new Set(['candidate_id', 'confirmed_candidate_id', 'booking_id', 'from_hold_id', 'guest_name']);

export function useMembers() {
  const { workspace } = useApp();
  return useQuery({ queryKey: ['members', workspace.id], queryFn: () => api.listMembers(workspace.id), refetchInterval: false });
}

function useValueFormatter(group: 'hold' | 'payment' | 'booking', locale: AppLocale, timeZone: string) {
  const { t } = useTranslation();
  return (field: string, value: unknown): string => {
    if (value == null || value === '') return '—';
    if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
    if (MONEY_FIELDS.has(field) && typeof value === 'number') return formatMoney(value, locale);
    if (field === 'status' && typeof value === 'string') return t(`status.${group}.${value}`);
    if (ENUM_FIELDS[field] && typeof value === 'string') return t(`${ENUM_FIELDS[field]}.${value}`);
    if (field === 'expires_at' && typeof value === 'string') return formatDateTime(value, locale, timeZone);
    if (isISODate(value)) return formatDate(value, locale);
    return String(value);
  };
}

/** Chronological audit trail: what happened, when, who did it, why, and old -> new values. */
export function AuditList({ events, group, timeZone }: { events: AuditEvent[]; group: 'hold' | 'payment' | 'booking'; timeZone: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const members = useMembers();
  const format = useValueFormatter(group, locale, timeZone);
  if (events.length === 0) return <Empty>{t('audit.empty')}</Empty>;
  const actor = (id: string | null) => (id ? (members.data?.find((m) => m.user_id === id)?.email ?? t('audit.formerMember')) : t('audit.system'));

  return (
    <ol className="audit">
      {events.map((event) => {
        const fields = [...new Set([...Object.keys(event.previous_values ?? {}), ...Object.keys(event.new_values ?? {})])].filter(
          (f) => !HIDDEN_FIELDS.has(f),
        );
        return (
          <li key={event.id}>
            <div className="audit-head">
              <strong>{t(`audit.${group}.${event.event_type}`)}</strong>
              <time dateTime={event.event_at}>{formatDateTime(event.event_at, locale, timeZone)}</time>
            </div>
            <div className="muted small">{actor(event.actor_id)}</div>
            {event.reason ? (
              <div className="small">
                {t('common.reason')}: {event.reason}
              </div>
            ) : null}
            {fields.length > 0 ? (
              <ul className="audit-changes small">
                {fields.map((field) => {
                  const before = event.previous_values?.[field];
                  const after = event.new_values?.[field];
                  const changed = event.previous_values && field in event.previous_values && JSON.stringify(before) !== JSON.stringify(after);
                  if (event.previous_values && field in event.previous_values && !changed) return null;
                  return (
                    <li key={field}>
                      {t(`audit.field.${field}`, { defaultValue: field })}:{' '}
                      {changed ? (
                        <>
                          <s>{format(field, before)}</s> → {format(field, after)}
                        </>
                      ) : (
                        format(field, after ?? before)
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

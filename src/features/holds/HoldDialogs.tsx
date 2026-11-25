import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext';
import { AuditList } from '../../components/AuditList';
import { ErrorMessage, Field, FormActions, Modal, Notice, QueryGate } from '../../components/ui';
import { useAction, useEvents, useLocale } from '../../hooks/data';
import * as api from '../../services/api';
import type { Hold } from '../../types/database';
import { isISODate, zonedDateOf, zonedTimeOf, zonedTimeToInstant, type ISODate } from '../../utils/dates';
import { describeDeadline, formatDateRange } from '../../utils/format';

type Preset = '24h' | '48h' | 'custom';

interface DeadlineState {
  preset: Preset;
  date: string;
  time: string;
}

/** Latest allowed deadline: check-in day at the property's check-in time, in its time zone. */
function cutoffFor(startDate: ISODate, checkInTime: string, timeZone: string): Date {
  return zonedTimeToInstant(startDate, checkInTime.slice(0, 5), timeZone);
}

function resolveDeadline(state: DeadlineState, timeZone: string, now: Date): Date | null {
  if (state.preset === '24h') return new Date(now.getTime() + 24 * 3600_000);
  if (state.preset === '48h') return new Date(now.getTime() + 48 * 3600_000);
  if (!isISODate(state.date) || !/^\d{2}:\d{2}$/.test(state.time)) return null;
  return zonedTimeToInstant(state.date, state.time, timeZone);
}

function useDeadline(startDate: ISODate, propertyId: string, initial: Preset) {
  const { allProperties } = useApp();
  const property = allProperties.find((p) => p.id === propertyId);
  const timeZone = property?.timezone ?? 'Europe/Madrid';
  const cutoff = cutoffFor(startDate, property?.check_in_time ?? '16:00', timeZone);
  const [state, setState] = useState<DeadlineState>(() => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000);
    return { preset: initial, date: zonedDateOf(tomorrow, timeZone), time: '20:00' };
  });
  const deadline = resolveDeadline(state, timeZone, new Date());
  const problem: 'validation.deadlineRequired' | 'validation.deadlinePast' | 'validation.deadlineAfterCheckIn' | null = !deadline
    ? 'validation.deadlineRequired'
    : deadline.getTime() <= Date.now()
      ? 'validation.deadlinePast'
      : deadline.getTime() > cutoff.getTime()
        ? 'validation.deadlineAfterCheckIn'
        : null;
  return { state, setState, deadline, problem, timeZone, cutoff };
}

function DeadlineFields({ model, presets }: { model: ReturnType<typeof useDeadline>; presets: Preset[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { state, setState, timeZone, cutoff, problem } = model;
  const cutoffText = describeDeadline(cutoff, locale, timeZone);
  return (
    <fieldset className="fieldset">
      <legend>{t('holds.until')}</legend>
      <div className="segmented" role="radiogroup" aria-label={t('holds.until')}>
        {presets.map((preset) => (
          <label key={preset}>
            <input type="radio" name="hold-preset" checked={state.preset === preset} onChange={() => setState({ ...state, preset })} />
            {t(`holds.preset.${preset}`)}
          </label>
        ))}
      </div>
      {state.preset === 'custom' ? (
        <div className="grid-2">
          <Field label={t('common.date')}>
            <input type="date" value={state.date} onChange={(e) => setState({ ...state, date: e.target.value })} />
          </Field>
          <Field label={t('holds.time')} hint={t('holds.timeZoneHint', { timeZone })}>
            <input type="time" value={state.time} onChange={(e) => setState({ ...state, time: e.target.value })} />
          </Field>
        </div>
      ) : null}
      {problem ? (
        <p className="field-error" role="alert">
          {t(problem, { cutoff: t(`holds.deadline.${cutoffText.kind}`, cutoffText) })}
        </p>
      ) : null}
    </fieldset>
  );
}

interface HoldTarget {
  candidateId: string;
  guestName: string;
  propertyId: string;
  startDate: ISODate;
  endDate: ISODate;
}

/** Create a hold: choose the deadline, review guest / dates / deadline, then confirm. */
export function CreateHoldDialog({ target, onClose }: { target: HoldTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const model = useDeadline(target.startDate, target.propertyId, '24h');
  const [notes, setNotes] = useState('');
  const action = useAction((expiresAt: Date) => api.createHold(target.candidateId, expiresAt, notes), onClose);
  const deadlineText = model.deadline ? describeDeadline(model.deadline, locale, model.timeZone) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (model.deadline && !model.problem) action.run(model.deadline);
  };
  return (
    <Modal title={t('holds.createTitle')} onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        <DeadlineFields model={model} presets={['24h', '48h', 'custom']} />
        <Field label={t('common.notesOptional')}>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="summary-box" data-testid="hold-summary">
          <strong>{t('holds.confirmQuestion')}</strong>
          <dl className="definition">
            <dt>{t('common.guest')}</dt>
            <dd>{target.guestName}</dd>
            <dt>{t('common.dates')}</dt>
            <dd>{formatDateRange(target.startDate, target.endDate, locale)}</dd>
            <dt>{t('holds.expiry')}</dt>
            <dd>{deadlineText && !model.problem ? t(`holds.deadline.${deadlineText.kind}`, deadlineText) : '—'}</dd>
          </dl>
          <p className="muted small">{t('holds.confirmExplain')}</p>
        </div>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('holds.createConfirm')} />
      </form>
    </Modal>
  );
}

export function ExtendHoldDialog({ hold, onClose }: { hold: Hold; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const model = useDeadline(hold.start_date, hold.property_id, 'custom');
  const action = useAction((expiresAt: Date) => api.extendHold(hold.id, expiresAt), onClose);
  const current = describeDeadline(hold.expires_at, locale, hold.property_timezone);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (model.deadline && !model.problem) action.run(model.deadline);
  };
  return (
    <Modal title={t('holds.extendTitle')} onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        <p>
          {t('holds.currentDeadline', { guest: hold.guest_name, when: t(`holds.deadline.${current.kind}`, current) })}
        </p>
        <DeadlineFields model={model} presets={['24h', '48h', 'custom']} />
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('holds.extendConfirm')} />
      </form>
    </Modal>
  );
}

export function ReleaseHoldDialog({ hold, onClose }: { hold: Hold; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [reason, setReason] = useState('');
  const action = useAction(() => api.releaseHold(hold.id, reason), onClose);
  return (
    <Modal title={t('holds.releaseTitle')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(undefined);
        }}
      >
        <Notice kind="warning">
          {t('holds.releaseExplain', { guest: hold.guest_name, dates: formatDateRange(hold.start_date, hold.end_date, locale) })}
        </Notice>
        <Field label={t('common.reasonOptional')}>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('holds.releaseConfirm')} danger />
      </form>
    </Modal>
  );
}

export function HoldHistoryDialog({ hold, onClose }: { hold: Hold; onClose: () => void }) {
  const { t } = useTranslation();
  const events = useEvents('hold', hold.id);
  return (
    <Modal title={t('holds.historyTitle', { guest: hold.guest_name })} onClose={onClose}>
      <QueryGate queries={[events]}>{() => <AuditList events={events.data ?? []} group="hold" timeZone={hold.property_timezone} />}</QueryGate>
      {hold.effective_status === 'expired' && hold.status === 'active' ? (
        <p className="muted small">
          {t('holds.expiredNotRecorded', { when: zonedDateOf(new Date(hold.expires_at), hold.property_timezone) + ' ' + zonedTimeOf(new Date(hold.expires_at), hold.property_timezone) })}
        </p>
      ) : null}
    </Modal>
  );
}

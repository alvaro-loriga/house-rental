import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useErrorText, useLocale, useNow } from '../hooks/data';
import { describeDeadline, formatMoney, minutesUntil } from '../utils/format';
import { telHref, whatsappHref } from '../utils/phone';

// --- Modal ---------------------------------------------------------------------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useTranslation();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal modal-wide' : 'modal'}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function FormActions({ onCancel, pending, submitLabel, danger }: { onCancel: () => void; pending: boolean; submitLabel: string; danger?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="form-actions">
      <button type="button" className="button" onClick={onCancel} disabled={pending}>
        {t('common.cancel')}
      </button>
      <button type="submit" className={danger ? 'button button-danger' : 'button button-primary'} disabled={pending} aria-busy={pending}>
        {pending ? t('common.saving') : submitLabel}
      </button>
    </div>
  );
}

// --- Feedback ------------------------------------------------------------------
export function ErrorMessage({ error }: { error: unknown }) {
  const errorText = useErrorText();
  if (!error) return null;
  return (
    <p className="alert alert-error" role="alert">
      {errorText(error)}
    </p>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  return (
    <p className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

interface QueryLike {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** Loading / error-with-retry wrapper around one or more queries. */
export function QueryGate({ queries, children }: { queries: QueryLike[]; children: () => ReactNode }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const failed = queries.find((q) => q.isError);
  if (failed) {
    return (
      <div className="state" role="alert">
        <p>{errorText(failed.error)}</p>
        <button type="button" className="button" onClick={() => queries.forEach((q) => q.isError && q.refetch())}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (queries.some((q) => q.isPending)) {
    return (
      <div className="state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        {t('common.loading')}
      </div>
    );
  }
  return <>{children()}</>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

// --- Form fields ---------------------------------------------------------------
export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className={error ? 'field field-invalid' : 'field'}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

// --- Display -------------------------------------------------------------------
export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  const locale = useLocale();
  return <span className={className ? `money ${className}` : 'money'}>{formatMoney(value, locale)}</span>;
}

type BadgeGroup = 'candidate' | 'booking' | 'hold' | 'period' | 'payment';
const BADGE_ICON: Record<string, string> = {
  interested: '○',
  undecided: '?',
  awaiting_response: '…',
  confirmed: '✓',
  discarded: '✕',
  provisional: '~',
  cancelled: '✕',
  completed: '✓✓',
  active: '⏳',
  released: '↩',
  expired: '⌛',
  converted: '✓',
  open: '○',
  booked: '✓',
  closed: '—',
  unpaid: '○',
  partially_paid: '◐',
  paid: '●',
  overpaid: '+',
};

/** Status label with an icon as well as a colour, so it never relies on colour alone. */
export function StatusBadge({ group, value }: { group: BadgeGroup; value: string }) {
  const { t } = useTranslation();
  return (
    <span className={`badge badge-${group}-${value}`}>
      <span aria-hidden="true">{BADGE_ICON[value] ?? '•'}</span> {t(`status.${group}.${value}`)}
    </span>
  );
}

export function PhoneLinks({ phone }: { phone: string | null | undefined }) {
  const { t } = useTranslation();
  if (!phone) return null;
  const tel = telHref(phone);
  const whatsapp = whatsappHref(phone);
  return (
    <span className="phone-links">
      {tel ? (
        <a href={tel} aria-label={t('common.callNumber', { phone })}>
          {phone}
        </a>
      ) : (
        phone
      )}
      {whatsapp ? (
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="chip-link">
          WhatsApp
        </a>
      ) : null}
    </span>
  );
}

/** "Expires tomorrow at 20:00 · 26 h left" — the hold deadline, always in the property's time zone. */
export function HoldDeadline({ expiresAt, timeZone, compact }: { expiresAt: string; timeZone: string; compact?: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow();
  const minutes = minutesUntil(expiresAt, now);
  const deadline = describeDeadline(expiresAt, locale, timeZone, now);
  const when = t(`holds.deadline.${deadline.kind}`, deadline);
  if (minutes < 0) return <span className="hold-deadline hold-deadline-expired">{t('holds.expiredAt', { when })}</span>;
  const remaining =
    minutes < 60
      ? t('holds.remaining.minutes', { count: Math.max(1, minutes) })
      : minutes < 48 * 60
        ? t('holds.remaining.hours', { count: Math.floor(minutes / 60) })
        : t('holds.remaining.days', { count: Math.floor(minutes / 1440) });
  return (
    <span className={minutes < 180 ? 'hold-deadline hold-deadline-soon' : 'hold-deadline'}>
      {t('holds.expiresAt', { when })}
      {compact ? null : <span className="hold-remaining"> · {remaining}</span>}
    </span>
  );
}

export function PageHeader({ title, actions, back }: { title: string; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {back}
        <h1>{title}</h1>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Stat({ label, value, tone, help }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' | 'good'; help?: string }) {
  return (
    <div className={tone ? `stat stat-${tone}` : 'stat'}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {help ? <span className="stat-help">{help}</span> : null}
    </div>
  );
}

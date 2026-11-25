import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AuditList } from '../../components/AuditList';
import { ErrorMessage, Field, FormActions, Modal, Money, Notice, QueryGate } from '../../components/ui';
import { useAction, useEvents, useLocale } from '../../hooks/data';
import * as api from '../../services/api';
import { PAYMENT_METHODS, PAYMENT_TYPES, type Booking, type Installment, type Payment, type PaymentMethod, type PaymentType } from '../../types/database';
import { isISODate, todayInZone } from '../../utils/dates';
import { formatDateRange, formatMoney } from '../../utils/format';
import { fromCents, parseMoney, sumCents, toCents } from '../../utils/money';
import { proposeMonthlySchedule } from '../../utils/pricing';

interface BookingRef {
  id: string;
  guest_name: string;
  start_date: string;
  end_date: string;
  property_timezone?: string;
  net_paid?: number;
  outstanding?: number;
  status?: string;
}

/** Record a payment or refund, or correct an existing one (which needs a reason). */
export function PaymentDialog({ booking, payment, presetType, onClose }: { booking: BookingRef; payment?: Payment; presetType?: PaymentType; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const timeZone = booking.property_timezone ?? 'Europe/Madrid';
  const [amount, setAmount] = useState(payment ? String(payment.amount) : '');
  const [date, setDate] = useState<string>(payment?.payment_date ?? todayInZone(timeZone));
  const [method, setMethod] = useState<PaymentMethod>(payment?.payment_method ?? 'bank_transfer');
  const [type, setType] = useState<PaymentType>(payment?.payment_type ?? presetType ?? 'partial_payment');
  const [notes, setNotes] = useState(payment?.notes ?? '');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const parsed = parseMoney(amount);
  const amountError = parsed == null || parsed <= 0 ? 'validation.invalidAmount' : null;
  const dateError = isISODate(date) ? null : 'validation.required';
  const reasonError = payment && !reason.trim() ? 'validation.reasonRequired' : null;
  const input = (): api.PaymentInput => ({ amount: parsed!, payment_date: date, payment_method: method, payment_type: type, notes });
  const action = useAction(async () => {
    if (payment) await api.correctPayment(payment.id, input(), reason.trim());
    else await api.recordPayment(booking.id, input());
  }, onClose);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (amountError || dateError || reasonError) return;
    action.run(undefined);
  };
  const title = payment ? t('payments.correctTitle') : type === 'refund' ? t('payments.refundTitle') : t('payments.addTitle');

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        <p className="muted">
          {booking.guest_name} · {formatDateRange(booking.start_date, booking.end_date, locale)}
        </p>
        {type === 'refund' && booking.net_paid != null ? (
          <Notice kind="info">{t('payments.refundHint', { netPaid: formatMoney(booking.net_paid, locale) })}</Notice>
        ) : null}
        <div className="grid-2">
          <Field label={t('common.amount')} error={submitted && amountError ? t(amountError) : null} hint={t('payments.amountHint')}>
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <Field label={t('payments.date')} error={submitted && dateError ? t(dateError) : null}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div className="grid-2">
          <Field label={t('payments.type')}>
            <select value={type} onChange={(e) => setType(e.target.value as PaymentType)}>
              {PAYMENT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(`paymentType.${v}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('payments.method')}>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((v) => (
                <option key={v} value={v}>
                  {t(`paymentMethod.${v}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('common.notesOptional')}>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {payment ? (
          <Field label={t('payments.correctionReason')} error={submitted && reasonError ? t(reasonError) : null}>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

export function VoidPaymentDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const action = useAction(() => api.voidPayment(payment.id, reason.trim()), onClose);
  return (
    <Modal title={t('payments.voidTitle')} onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (reason.trim()) action.run(undefined);
        }}
      >
        <Notice kind="warning">
          {t('payments.voidExplain', { amount: formatMoney(payment.amount, locale), type: t(`paymentType.${payment.payment_type}`) })}
        </Notice>
        <Field label={t('common.reason')} error={submitted && !reason.trim() ? t('validation.reasonRequired') : null}>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('payments.voidConfirm')} danger />
      </form>
    </Modal>
  );
}

export function PaymentHistoryDialog({ payment, timeZone, onClose }: { payment: Payment; timeZone: string; onClose: () => void }) {
  const { t } = useTranslation();
  const events = useEvents('payment', payment.id);
  return (
    <Modal title={t('payments.historyTitle')} onClose={onClose}>
      <QueryGate queries={[events]}>{() => <AuditList events={events.data ?? []} group="payment" timeZone={timeZone} />}</QueryGate>
    </Modal>
  );
}

interface Row {
  key: number;
  due_date: string;
  amount: string;
  description: string;
}
let rowKey = 0;
const toRow = (item: { due_date: string; amount: number; description?: string | null }): Row => ({
  key: ++rowKey,
  due_date: item.due_date,
  amount: String(item.amount),
  description: item.description ?? '',
});

/**
 * Edit the planned instalments of a booking. A schedule is a plan, not money received.
 * "Propose monthly schedule" replaces the rows on screen (nothing is saved until Save, and
 * saving replaces the stored schedule as a whole, so regenerating never duplicates).
 */
export function InstallmentsDialog({ booking, installments, onClose }: { booking: Booking; installments: Installment[]; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [rows, setRows] = useState<Row[]>(() => installments.map(toRow));
  const [submitted, setSubmitted] = useState(false);

  const parsedRows = rows.map((r) => ({ ...r, value: parseMoney(r.amount) }));
  const invalid = parsedRows.some((r) => !isISODate(r.due_date) || r.value == null || r.value <= 0);
  const total = fromCents(sumCents(parsedRows.map((r) => r.value)));
  const difference = fromCents(toCents(booking.total_price) - toCents(total));
  const action = useAction(
    () => api.setInstallments(booking.id, parsedRows.map((r) => ({ due_date: r.due_date, amount: r.value!, description: r.description.trim() || null }))),
    onClose,
  );
  const update = (key: number, patch: Partial<Row>) => setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const propose = () =>
    setRows(
      proposeMonthlySchedule(booking.start_date, booking.end_date, booking.total_price, booking.pricing_type === 'per_month' ? booking.unit_price : null).map(toRow),
    );

  return (
    <Modal title={t('installments.editTitle')} onClose={onClose} wide>
      <form
        className="stack"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setSubmitted(true);
          if (!invalid) action.run(undefined);
        }}
      >
        <p className="muted small">{t('installments.explain')}</p>
        <div className="button-row">
          <button type="button" className="button" onClick={propose}>
            {t('installments.propose')}
          </button>
          <button type="button" className="button" onClick={() => setRows((r) => [...r, { key: ++rowKey, due_date: '', amount: '', description: '' }])}>
            + {t('installments.addRow')}
          </button>
        </div>
        {rows.length === 0 ? <p className="muted">{t('installments.none')}</p> : null}
        <ol className="installment-editor">
          {rows.map((row, index) => (
            <li key={row.key}>
              <Field label={t('installments.dueDate', { n: index + 1 })}>
                <input type="date" value={row.due_date} onChange={(e) => update(row.key, { due_date: e.target.value })} />
              </Field>
              <Field label={t('common.amount')}>
                <input type="text" inputMode="decimal" value={row.amount} onChange={(e) => update(row.key, { amount: e.target.value })} />
              </Field>
              <Field label={t('installments.description')}>
                <input type="text" value={row.description} onChange={(e) => update(row.key, { description: e.target.value })} />
              </Field>
              <button type="button" className="icon-button" aria-label={t('installments.removeRow', { n: index + 1 })} onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}>
                ✕
              </button>
            </li>
          ))}
        </ol>
        <div className="summary-box">
          <div className="card-row">
            <span>{t('installments.scheduled', { count: rows.length })}</span>
            <Money value={total} className="money-strong" />
          </div>
          <div className="card-row">
            <span>{t('pricing.agreedTotal')}</span>
            <Money value={booking.total_price} />
          </div>
        </div>
        {rows.length > 0 && difference !== 0 ? (
          <Notice kind="warning">{t(difference > 0 ? 'installments.diffUnder' : 'installments.diffOver', { amount: formatMoney(Math.abs(difference), locale) })}</Notice>
        ) : null}
        {submitted && invalid ? <Notice kind="error">{t('installments.invalid')}</Notice> : null}
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

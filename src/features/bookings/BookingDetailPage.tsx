import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { AuditList } from '../../components/AuditList';
import { parsePrice, PriceFields, StayFields, validateStay, type PriceDraft } from '../../components/forms';
import { Empty, ErrorMessage, Field, FormActions, Modal, Money, Notice, PageHeader, PhoneLinks, QueryGate, Stat, StatusBadge } from '../../components/ui';
import { useAction, useBookings, useEvents, useInstallments, useLocale, usePayments } from '../../hooks/data';
import * as api from '../../services/api';
import type { Booking, Payment, PaymentType } from '../../types/database';
import { todayInZone } from '../../utils/dates';
import { allocateToInstallments } from '../../utils/finance';
import { formatDate, formatDateLong, formatMoney } from '../../utils/format';
import { parseMoney } from '../../utils/money';
import { pricePerNight } from '../../utils/pricing';
import { InstallmentsDialog, PaymentDialog, PaymentHistoryDialog, VoidPaymentDialog } from '../payments/PaymentDialogs';

function EditBookingDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { t } = useTranslation();
  const [start, setStart] = useState<string>(booking.start_date);
  const [end, setEnd] = useState<string>(booking.end_date);
  const [price, setPrice] = useState<PriceDraft>({
    pricing_type: booking.pricing_type,
    unit: booking.unit_price != null ? String(booking.unit_price) : '',
    total: String(booking.total_price),
    deposit: booking.deposit_required ? String(booking.deposit_required) : '',
    notes: booking.notes ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const stayError = validateStay(start, end);
  const parsed = parsePrice(price);
  const datesChanged = start !== booking.start_date || end !== booking.end_date;
  const action = useAction(() => api.updateBooking(booking.id, { ...parsed.value!, start_date: start, end_date: end }), onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (stayError || parsed.error) return;
    action.run(undefined);
  };
  return (
    <Modal title={t('bookings.editTitle')} onClose={onClose} wide>
      <form onSubmit={submit} className="stack" noValidate>
        <StayFields
          start={start}
          end={end}
          onChange={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
          error={submitted && stayError ? t(stayError) : null}
        />
        {datesChanged && booking.status !== 'provisional' ? <Notice kind="warning">{t('bookings.datesChangeWarning')}</Notice> : null}
        <PriceFields draft={price} onChange={setPrice} start={stayError ? '' : start} end={stayError ? '' : end} error={submitted && parsed.error ? t(parsed.error) : null} />
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('common.save')} />
      </form>
    </Modal>
  );
}

function CancelBookingDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [reason, setReason] = useState('');
  const [fee, setFee] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const reasonRequired = booking.status === 'confirmed';
  const parsedFee = fee.trim() === '' ? null : parseMoney(fee);
  const feeInvalid = fee.trim() !== '' && parsedFee == null;
  const action = useAction(() => api.setBookingStatus(booking.id, 'cancelled', reason, parsedFee), onClose);
  return (
    <Modal title={t('bookings.cancelTitle')} onClose={onClose}>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if ((reasonRequired && !reason.trim()) || feeInvalid) return;
          action.run(undefined);
        }}
      >
        <Notice kind="warning">{t('bookings.cancelExplain')}</Notice>
        {booking.net_paid > 0 ? <Notice kind="info">{t('bookings.cancelPaidHint', { amount: formatMoney(booking.net_paid, locale) })}</Notice> : null}
        <Field label={reasonRequired ? t('common.reason') : t('common.reasonOptional')} error={submitted && reasonRequired && !reason.trim() ? t('validation.reasonRequired') : null}>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label={t('bookings.cancellationFee')} hint={t('bookings.cancellationFeeHint')} error={submitted && feeInvalid ? t('validation.invalidAmount') : null}>
          <input type="text" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('bookings.cancelConfirm')} danger />
      </form>
    </Modal>
  );
}

type Dialog =
  | { kind: 'pay'; type: PaymentType }
  | { kind: 'correct'; payment: Payment }
  | { kind: 'void'; payment: Payment }
  | { kind: 'paymentHistory'; payment: Payment }
  | { kind: 'edit' }
  | { kind: 'cancel' }
  | { kind: 'installments' };

export function BookingDetailPage() {
  const { bookingId } = useParams();
  const { t } = useTranslation();
  const locale = useLocale();
  const bookings = useBookings();
  const paymentsQuery = usePayments();
  const installmentsQuery = useInstallments(bookingId);
  const events = useEvents('booking', bookingId);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const close = () => setDialog(null);
  const statusAction = useAction((status: 'confirmed' | 'completed') => api.setBookingStatus(bookingId!, status));

  return (
    <QueryGate queries={[bookings, paymentsQuery, installmentsQuery]}>
      {() => {
        const booking = bookings.data!.find((b) => b.id === bookingId);
        if (!booking) return <Empty action={<Link to="/bookings">{t('common.back')}</Link>}>{t('errors.NOT_FOUND')}</Empty>;
        const payments = paymentsQuery.data!.filter((p) => p.booking_id === booking.id);
        const today = todayInZone(booking.property_timezone);
        const schedule = allocateToInstallments(installmentsQuery.data ?? [], booking.net_paid, today);
        const cancelled = booking.status === 'cancelled';
        const perNight = pricePerNight(booking.total_price, booking.nights);
        const depositMissing = !cancelled && booking.deposit_required > 0 && booking.deposit_paid < booking.deposit_required;
        const credit = booking.outstanding < 0;

        return (
          <>
            <PageHeader
              back={
                <Link to="/bookings" className="back-link">
                  ← {t('nav.bookings')}
                </Link>
              }
              title={booking.guest_name}
              actions={<StatusBadge group="booking" value={booking.status} />}
            />
            <div className="meta-row">
              <strong>
                {formatDateLong(booking.start_date, locale)} → {formatDateLong(booking.end_date, locale)}
              </strong>
              <span>{t('common.nights', { count: booking.nights })}</span>
              <span>{booking.property_name}</span>
            </div>
            <p className="muted small">{t('common.checkOutHint')}</p>

            <div className="stats">
              <Stat label={t('common.total')} value={<Money value={booking.total_price} />} />
              <Stat label={t('common.paid')} value={<Money value={booking.net_paid} />} tone="good" help={booking.paid_percent != null ? `${booking.paid_percent} %` : undefined} />
              {cancelled ? (
                <Stat label={t('bookings.retained')} value={<Money value={booking.net_paid} />} help={t('bookings.retainedHelp')} />
              ) : (
                <Stat
                  label={credit ? t('bookings.credit') : t('common.outstanding')}
                  value={<Money value={Math.abs(booking.outstanding)} />}
                  tone={credit ? 'warn' : booking.outstanding > 0 ? 'warn' : 'good'}
                />
              )}
              {booking.overdue > 0 ? <Stat label={t('common.overdue')} value={<Money value={booking.overdue} />} tone="danger" /> : null}
            </div>
            <p className="badge-row">
              <StatusBadge group="payment" value={booking.payment_status} />
              {booking.refunds > 0 ? (
                <span className="muted small">
                  {t('bookings.receiptsRefunds', { receipts: formatMoney(booking.gross_receipts, locale), refunds: formatMoney(booking.refunds, locale) })}
                </span>
              ) : null}
            </p>
            {depositMissing ? (
              <Notice kind="warning">
                {t('bookings.depositMissing', { required: formatMoney(booking.deposit_required, locale), paid: formatMoney(booking.deposit_paid, locale) })}
              </Notice>
            ) : null}
            {credit ? <Notice kind="warning">{t('bookings.creditNotice', { amount: formatMoney(-booking.outstanding, locale) })}</Notice> : null}
            {cancelled ? (
              <Notice kind="info">
                {t('bookings.cancelledNotice', { date: formatDate(booking.cancelled_at?.slice(0, 10), locale) })}
                {booking.cancellation_reason ? ` ${t('common.reason')}: ${booking.cancellation_reason}.` : ''}
                {booking.cancellation_fee != null ? ` ${t('bookings.cancellationFee')}: ${formatMoney(booking.cancellation_fee, locale)}.` : ''}
              </Notice>
            ) : null}
            <ErrorMessage error={statusAction.error} />

            <div className="button-row">
              <button type="button" className="button button-primary" onClick={() => setDialog({ kind: 'pay', type: booking.net_paid === 0 && booking.deposit_required > 0 ? 'deposit' : 'partial_payment' })}>
                + {t('payments.add')}
              </button>
              <button type="button" className="button" disabled={booking.net_paid <= 0} onClick={() => setDialog({ kind: 'pay', type: 'refund' })}>
                {t('payments.refund')}
              </button>
              {!cancelled ? (
                <button type="button" className="button" onClick={() => setDialog({ kind: 'edit' })}>
                  {t('bookings.edit')}
                </button>
              ) : null}
              {booking.status === 'provisional' ? (
                <button type="button" className="button" disabled={statusAction.pending} onClick={() => statusAction.run('confirmed')}>
                  {t('bookings.confirm')}
                </button>
              ) : null}
              {booking.status === 'confirmed' ? (
                <button type="button" className="button" disabled={statusAction.pending} onClick={() => statusAction.run('completed')}>
                  {t('bookings.markCompleted')}
                </button>
              ) : null}
              {booking.status === 'completed' ? (
                <button type="button" className="button" disabled={statusAction.pending} onClick={() => statusAction.run('confirmed')}>
                  {t('bookings.reopen')}
                </button>
              ) : null}
              {booking.status === 'provisional' || booking.status === 'confirmed' ? (
                <button type="button" className="button button-danger-outline" onClick={() => setDialog({ kind: 'cancel' })}>
                  {t('bookings.cancel')}
                </button>
              ) : null}
            </div>

            <section className="section">
              <h2>{t('bookings.details')}</h2>
              <dl className="definition">
                <dt>{t('common.guest')}</dt>
                <dd>
                  <Link to={`/guests/${booking.guest_id}`}>{booking.guest_name}</Link>
                </dd>
                <dt>{t('common.phone')}</dt>
                <dd>{booking.guest_phone ? <PhoneLinks phone={booking.guest_phone} /> : '—'}</dd>
                <dt>{t('common.email')}</dt>
                <dd>{booking.guest_email ? <a href={`mailto:${booking.guest_email}`}>{booking.guest_email}</a> : '—'}</dd>
                <dt>{t('pricing.type')}</dt>
                <dd>
                  {t(`pricingType.${booking.pricing_type}`)}
                  {booking.unit_price != null ? ` · ${formatMoney(booking.unit_price, locale)}` : ''}
                </dd>
                <dt>{t('bookings.perNight')}</dt>
                <dd>{perNight != null ? formatMoney(perNight, locale) : '—'}</dd>
                <dt>{t('pricing.deposit')}</dt>
                <dd>{booking.deposit_required > 0 ? formatMoney(booking.deposit_required, locale) : t('bookings.noDeposit')}</dd>
                <dt>{t('bookings.bookedOn')}</dt>
                <dd>{formatDate(booking.booking_date, locale)}</dd>
                <dt>{t('common.notes')}</dt>
                <dd>{booking.notes ?? '—'}</dd>
              </dl>
            </section>

            <section className="section">
              <div className="section-head">
                <h2>{t('installments.title')}</h2>
                <button type="button" className="button" onClick={() => setDialog({ kind: 'installments' })}>
                  {schedule.length > 0 ? t('common.edit') : t('installments.create')}
                </button>
              </div>
              {schedule.length === 0 ? (
                <p className="muted">{t('installments.none')}</p>
              ) : (
                <>
                  <p className="muted small">
                    {t('installments.summary', { due: formatMoney(booking.due_to_date, locale), scheduled: formatMoney(booking.scheduled_total, locale) })} {t('installments.convention')}
                  </p>
                  <ul className="plain-list" data-testid="schedule">
                    {schedule.map((item) => (
                      <li key={item.id} className="card-row">
                        <span>
                          {formatDate(item.due_date, locale)}
                          {item.description ? <span className="muted small"> · {item.description}</span> : null}
                        </span>
                        <span className="badge-row">
                          <Money value={item.amount} />
                          <span className={`badge badge-installment-${item.state}`}>{t(`installments.state.${item.state}`)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="section">
              <h2>{t('payments.history')}</h2>
              {payments.length === 0 ? (
                <p className="muted">{t('payments.none')}</p>
              ) : (
                <ul className="card-list" data-testid="payments">
                  {payments.map((p) => (
                    <li key={p.id} className={p.voided_at ? 'card card-voided' : 'card'}>
                      <div className="card-row">
                        <span>
                          {formatDate(p.payment_date, locale)} · {t(`paymentType.${p.payment_type}`)} · {t(`paymentMethod.${p.payment_method}`)}
                        </span>
                        <Money value={p.signed_amount} className={p.payment_type === 'refund' ? 'money-strong money-danger' : 'money-strong'} />
                      </div>
                      {p.notes ? <p className="muted small">{p.notes}</p> : null}
                      {p.voided_at ? (
                        <p className="small">
                          <span className="badge badge-voided">{t('payments.voided')}</span> {p.void_reason}
                        </p>
                      ) : null}
                      <div className="button-row">
                        {!p.voided_at ? (
                          <>
                            <button type="button" className="link-button" onClick={() => setDialog({ kind: 'correct', payment: p })}>
                              {t('payments.correct')}
                            </button>
                            <button type="button" className="link-button" onClick={() => setDialog({ kind: 'void', payment: p })}>
                              {t('payments.void')}
                            </button>
                          </>
                        ) : null}
                        <button type="button" className="link-button" onClick={() => setDialog({ kind: 'paymentHistory', payment: p })}>
                          {t('common.history')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section">
              <div className="section-head">
                <h2>{t('bookings.history')}</h2>
                <button type="button" className="button" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
                  {showHistory ? t('common.hide') : t('common.show')}
                </button>
              </div>
              {showHistory ? <QueryGate queries={[events]}>{() => <AuditList events={events.data ?? []} group="booking" timeZone={booking.property_timezone} />}</QueryGate> : null}
            </section>

            {dialog?.kind === 'pay' ? <PaymentDialog booking={booking} presetType={dialog.type} onClose={close} /> : null}
            {dialog?.kind === 'correct' ? <PaymentDialog booking={booking} payment={dialog.payment} onClose={close} /> : null}
            {dialog?.kind === 'void' ? <VoidPaymentDialog payment={dialog.payment} onClose={close} /> : null}
            {dialog?.kind === 'paymentHistory' ? <PaymentHistoryDialog payment={dialog.payment} timeZone={booking.property_timezone} onClose={close} /> : null}
            {dialog?.kind === 'edit' ? <EditBookingDialog booking={booking} onClose={close} /> : null}
            {dialog?.kind === 'cancel' ? <CancelBookingDialog booking={booking} onClose={close} /> : null}
            {dialog?.kind === 'installments' ? <InstallmentsDialog booking={booking} installments={installmentsQuery.data ?? []} onClose={close} /> : null}
          </>
        );
      }}
    </QueryGate>
  );
}

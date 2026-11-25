import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { Empty, Money, PageHeader, QueryGate, Stat } from '../../components/ui';
import { useBookings, useLocale, usePayments } from '../../hooks/data';
import { PAYMENT_METHODS, type Payment } from '../../types/database';
import { todayInZone } from '../../utils/dates';
import { formatDate, monthName } from '../../utils/format';
import { fromCents, toCents } from '../../utils/money';
import { PaymentHistoryDialog } from './PaymentDialogs';

export function PaymentsPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { inScope, properties, timeZone } = useApp();
  const paymentsQuery = usePayments();
  const bookingsQuery = useBookings();
  const currentYear = Number(todayInZone(timeZone).slice(0, 4));
  const [year, setYear] = useState<string>(String(currentYear));
  const [month, setMonth] = useState<string>('all');
  const [method, setMethod] = useState<string>('all');
  const [guest, setGuest] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const [history, setHistory] = useState<Payment | null>(null);
  const showProperty = properties.length > 1;

  const scoped = useMemo(() => (paymentsQuery.data ?? []).filter((p) => inScope(p.property_id)), [paymentsQuery.data, inScope]);
  const years = useMemo(() => {
    const set = new Set<number>([currentYear]);
    for (const p of scoped) set.add(Number(p.payment_date.slice(0, 4)));
    return [...set].sort((a, b) => b - a);
  }, [scoped, currentYear]);

  const rows = scoped.filter((p) => {
    if (year !== 'all' && p.payment_date.slice(0, 4) !== year) return false;
    if (month !== 'all' && p.payment_date.slice(5, 7) !== month) return false;
    if (method !== 'all' && p.payment_method !== method) return false;
    if (guest.trim() && !p.guest_name.toLowerCase().includes(guest.trim().toLowerCase())) return false;
    return showVoided || !p.voided_at;
  });
  const valid = rows.filter((p) => !p.voided_at);
  const receipts = fromCents(valid.filter((p) => p.payment_type !== 'refund').reduce((s, p) => s + toCents(p.amount), 0));
  const refunds = fromCents(valid.filter((p) => p.payment_type === 'refund').reduce((s, p) => s + toCents(p.amount), 0));
  const live = (bookingsQuery.data ?? []).filter((b) => inScope(b.property_id) && (b.status === 'confirmed' || b.status === 'completed'));
  const outstanding = fromCents(live.reduce((s, b) => s + Math.max(0, toCents(b.outstanding)), 0));
  const overdue = fromCents(live.reduce((s, b) => s + toCents(b.overdue), 0));

  return (
    <>
      <PageHeader title={t('nav.payments')} actions={<Link to="/reports">{t('nav.reports')}</Link>} />
      <div className="toolbar">
        <select value={year} onChange={(e) => setYear(e.target.value)} aria-label={t('common.year')}>
          <option value="all">{t('payments.allYears')}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t('common.month')}>
          <option value="all">{t('payments.allMonths')}</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i} value={String(i + 1).padStart(2, '0')}>
              {monthName(i + 1, locale)}
            </option>
          ))}
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label={t('payments.method')}>
          <option value="all">{t('payments.allMethods')}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`paymentMethod.${m}`)}
            </option>
          ))}
        </select>
        <input type="search" value={guest} onChange={(e) => setGuest(e.target.value)} placeholder={t('payments.guestFilter')} aria-label={t('payments.guestFilter')} />
        <label className="check">
          <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
          {t('payments.showVoided')}
        </label>
      </div>
      <QueryGate queries={[paymentsQuery, bookingsQuery]}>
        {() => (
          <>
            <div className="stats">
              <Stat label={t('payments.netReceipts')} value={<Money value={fromCents(toCents(receipts) - toCents(refunds))} />} tone="good" help={t('payments.netHelp')} />
              <Stat label={t('payments.receipts')} value={<Money value={receipts} />} />
              <Stat label={t('payments.refunds')} value={<Money value={refunds} />} />
              <Stat label={t('common.outstanding')} value={<Money value={outstanding} />} tone={outstanding > 0 ? 'warn' : undefined} help={t('reports.help.outstandingShort')} />
              <Stat label={t('common.overdue')} value={<Money value={overdue} />} tone={overdue > 0 ? 'danger' : undefined} />
            </div>
            {rows.length === 0 ? (
              <Empty>{t('payments.empty')}</Empty>
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.guest')}</th>
                    <th>{t('payments.booking')}</th>
                    {showProperty ? <th>{t('common.property')}</th> : null}
                    <th>{t('payments.type')}</th>
                    <th>{t('payments.method')}</th>
                    <th className="num">{t('common.amount')}</th>
                    <th>{t('common.history')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className={p.voided_at ? 'row-voided' : ''}>
                      <td data-label={t('common.date')}>{formatDate(p.payment_date, locale)}</td>
                      <td data-label={t('common.guest')}>
                        <Link to={`/guests/${p.guest_id}`}>{p.guest_name}</Link>
                      </td>
                      <td data-label={t('payments.booking')}>
                        <Link to={`/bookings/${p.booking_id}`}>
                          {formatDate(p.start_date, locale)} – {formatDate(p.end_date, locale)}
                        </Link>
                      </td>
                      {showProperty ? <td data-label={t('common.property')}>{p.property_name}</td> : null}
                      <td data-label={t('payments.type')}>
                        {t(`paymentType.${p.payment_type}`)}
                        {p.voided_at ? <span className="badge badge-voided">{t('payments.voided')}</span> : null}
                      </td>
                      <td data-label={t('payments.method')}>{t(`paymentMethod.${p.payment_method}`)}</td>
                      <td data-label={t('common.amount')} className="num">
                        <Money value={p.signed_amount} className={p.payment_type === 'refund' ? 'money-strong money-danger' : 'money-strong'} />
                      </td>
                      <td data-label={t('common.history')}>
                        <button type="button" className="link-button" onClick={() => setHistory(p)}>
                          {t('common.history')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </QueryGate>
      {history ? <PaymentHistoryDialog payment={history} timeZone={timeZone} onClose={() => setHistory(null)} /> : null}
    </>
  );
}

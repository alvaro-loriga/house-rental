import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { Empty, HoldDeadline, Modal, Money, PageHeader, PhoneLinks, QueryGate, Stat, StatusBadge } from '../../components/ui';
import { useBookings, useCandidates, useHolds, useLocale, useNow, usePayments } from '../../hooks/data';
import type { Booking } from '../../types/database';
import { addDays, nightsWithin, todayInZone } from '../../utils/dates';
import { buildYearReport } from '../../utils/finance';
import { formatDate, formatDateRange, formatDateTime, formatPercent } from '../../utils/format';
import { PaymentDialog } from '../payments/PaymentDialogs';

function PickBookingForPayment({ bookings, onClose }: { bookings: Booking[]; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [picked, setPicked] = useState<Booking | null>(null);
  if (picked) return <PaymentDialog booking={picked} onClose={onClose} />;
  return (
    <Modal title={t('dashboard.pickBooking')} onClose={onClose}>
      {bookings.length === 0 ? (
        <Empty>{t('bookings.empty')}</Empty>
      ) : (
        <ul className="card-list">
          {bookings.map((b) => (
            <li key={b.id}>
              <button type="button" className="card card-button" onClick={() => setPicked(b)}>
                <span className="card-row">
                  <strong>{b.guest_name}</strong>
                  <Money value={b.outstanding} />
                </span>
                <span className="muted small">{formatDateRange(b.start_date, b.end_date, locale)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { inScope, properties, propertyFilter, timeZone } = useApp();
  const bookingsQuery = useBookings();
  const holdsQuery = useHolds();
  const candidatesQuery = useCandidates();
  const paymentsQuery = usePayments();
  const now = useNow(60_000);
  const [paying, setPaying] = useState(false);
  const today = todayInZone(timeZone, now);

  return (
    <>
      <PageHeader title={t('nav.dashboard')} />
      <div className="button-row quick-actions">
        <Link to="/prospects?new=1" className="button button-primary">
          + {t('dashboard.newCandidate')}
        </Link>
        <Link to="/bookings/new" className="button">
          + {t('bookings.new')}
        </Link>
        <button type="button" className="button" onClick={() => setPaying(true)}>
          + {t('payments.add')}
        </button>
      </div>
      <QueryGate queries={[bookingsQuery, holdsQuery, candidatesQuery, paymentsQuery]}>
        {() => {
          const bookings = bookingsQuery.data!.filter((b) => inScope(b.property_id));
          const holds = holdsQuery.data!.filter((h) => inScope(h.property_id));
          const candidates = candidatesQuery.data!.filter((c) => inScope(c.property_id));
          const payments = paymentsQuery.data!.filter((p) => inScope(p.property_id));
          const scopeCount = propertyFilter === 'all' ? properties.length : 1;

          const live = bookings.filter((b) => b.status === 'confirmed' || b.status === 'completed');
          const upcoming = bookings.filter((b) => b.status === 'confirmed' && b.end_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date));
          const next = upcoming[0];
          const owing = live.filter((b) => b.outstanding > 0).sort((a, b) => b.overdue - a.overdue || a.start_date.localeCompare(b.start_date));
          const report = buildYearReport(bookings, payments, Number(today.slice(0, 4)), scopeCount);
          const activeHolds = holds.filter((h) => h.is_effective).sort((a, b) => a.expires_at.localeCompare(b.expires_at));
          const weekAgo = now.getTime() - 7 * 86400_000;
          const expiredHolds = holds.filter(
            (h) => h.effective_status === 'expired' && new Date(h.expires_at).getTime() > weekAgo && h.candidate_status !== 'confirmed' && h.candidate_status !== 'discarded',
          );
          const waiting = candidates
            .filter((c) => (c.status === 'interested' || c.status === 'undecided' || c.status === 'awaiting_response') && c.period_status === 'open' && c.end_date > today)
            .sort((a, b) => a.start_date.localeCompare(b.start_date));
          const horizon = addDays(today, 30);
          const occupied = live.reduce((sum, b) => sum + nightsWithin(b.start_date, b.end_date, today, horizon), 0);
          const occupancy = scopeCount > 0 ? occupied / (30 * scopeCount) : 0;

          return (
            <>
              <section className="card next-stay" aria-labelledby="next-stay-title">
                <h2 id="next-stay-title">{next && next.start_date <= today ? t('dashboard.currentStay') : t('dashboard.nextStay')}</h2>
                {next ? (
                  <>
                    <Link to={`/bookings/${next.id}`} className="strong-link big">
                      {formatDateRange(next.start_date, next.end_date, locale)}
                    </Link>
                    <p>
                      {t('common.guest')}: {next.guest_name} <PhoneLinks phone={next.guest_phone} />
                    </p>
                    {properties.length > 1 ? <p className="muted small">{next.property_name}</p> : null}
                    <div className="stats stats-inline">
                      <Stat label={t('common.total')} value={<Money value={next.total_price} />} />
                      <Stat label={t('common.paid')} value={<Money value={next.net_paid} />} tone="good" />
                      <Stat label={t('common.outstanding')} value={<Money value={next.outstanding} />} tone={next.outstanding > 0 ? 'warn' : 'good'} />
                    </div>
                  </>
                ) : (
                  <p className="muted">{t('dashboard.noNextStay')}</p>
                )}
              </section>

              <div className="stats">
                <Stat label={t('dashboard.totalOutstanding')} value={<Money value={report.outstanding} />} tone={report.outstanding > 0 ? 'warn' : undefined} help={t('reports.help.outstandingShort')} />
                <Stat label={t('dashboard.totalOverdue')} value={<Money value={report.overdue} />} tone={report.overdue > 0 ? 'danger' : undefined} />
                <Stat label={t('dashboard.ytdNet', { year: report.year })} value={<Money value={report.netReceipts} />} tone="good" />
                <Stat label={t('dashboard.occupancy30')} value={formatPercent(occupancy, locale)} help={t('dashboard.occupancy30Help', { count: occupied })} />
              </div>

              <section className="section">
                <h2>{t('dashboard.activeHolds')}</h2>
                {activeHolds.length === 0 ? (
                  <p className="muted">{t('dashboard.noHolds')}</p>
                ) : (
                  <ul className="card-list">
                    {activeHolds.map((h) => (
                      <li key={h.id} className="card card-held">
                        <Link to={`/prospects/${h.booking_period_id}`} className="card-link">
                          <div className="card-row">
                            <strong>{h.guest_name}</strong>
                            <span>{formatDateRange(h.start_date, h.end_date, locale)}</span>
                          </div>
                          <p className="hold-line">
                            <HoldDeadline expiresAt={h.expires_at} timeZone={h.property_timezone} />
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {expiredHolds.length > 0 ? (
                <section className="section">
                  <h2>{t('dashboard.expiredHolds')}</h2>
                  <ul className="card-list">
                    {expiredHolds.map((h) => (
                      <li key={h.id} className="card">
                        <Link to={`/prospects/${h.booking_period_id}`} className="card-link">
                          <div className="card-row">
                            <strong>{h.guest_name}</strong>
                            <span>{formatDateRange(h.start_date, h.end_date, locale)}</span>
                          </div>
                          <p className="muted small">
                            {t('dashboard.expiredOn', { when: formatDateTime(h.expires_at, locale, h.property_timezone) })} · {t('dashboard.followUp')}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="section">
                <div className="section-head">
                  <h2>{t('dashboard.waiting')}</h2>
                  <Link to="/prospects">{t('common.viewAll')}</Link>
                </div>
                {waiting.length === 0 ? (
                  <p className="muted">{t('dashboard.noWaiting')}</p>
                ) : (
                  <ul className="plain-list">
                    {waiting.slice(0, 6).map((c) => (
                      <li key={c.id} className="card-row">
                        <Link to={`/prospects/${c.booking_period_id}`}>
                          {c.guest_name} · {formatDateRange(c.start_date, c.end_date, locale)}
                        </Link>
                        <span className="badge-row">
                          <Money value={c.proposed_price} />
                          <StatusBadge group="candidate" value={c.status} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="section">
                <div className="section-head">
                  <h2>{t('dashboard.upcoming')}</h2>
                  <Link to="/bookings">{t('common.viewAll')}</Link>
                </div>
                {upcoming.length === 0 ? (
                  <p className="muted">{t('dashboard.noUpcoming')}</p>
                ) : (
                  <ul className="plain-list">
                    {upcoming.slice(0, 5).map((b) => (
                      <li key={b.id} className="card-row">
                        <Link to={`/bookings/${b.id}`}>
                          {formatDateRange(b.start_date, b.end_date, locale)} · {b.guest_name}
                        </Link>
                        <StatusBadge group="payment" value={b.payment_status} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="section">
                <h2>{t('dashboard.owing')}</h2>
                {owing.length === 0 ? (
                  <p className="muted">{t('dashboard.noOwing')}</p>
                ) : (
                  <ul className="plain-list">
                    {owing.slice(0, 8).map((b) => (
                      <li key={b.id} className="card-row">
                        <Link to={`/bookings/${b.id}`}>
                          {b.guest_name} · {formatDate(b.start_date, locale)}
                        </Link>
                        <span className="badge-row">
                          <Money value={b.outstanding} className="money-strong" />
                          {b.overdue > 0 ? (
                            <span className="badge badge-overdue">
                              {t('common.overdue')}: <Money value={b.overdue} />
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {paying ? <PickBookingForPayment bookings={bookings.filter((b) => b.status !== 'cancelled' && b.end_date >= addDays(today, -60))} onClose={() => setPaying(false)} /> : null}
            </>
          );
        }}
      </QueryGate>
    </>
  );
}

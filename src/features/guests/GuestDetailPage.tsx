import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { Empty, ErrorMessage, FormActions, Modal, Money, Notice, PageHeader, PhoneLinks, QueryGate, Stat, StatusBadge } from '../../components/ui';
import { useAction, useBookings, useCandidates, useGuests, useLocale, usePayments } from '../../hooks/data';
import * as api from '../../services/api';
import type { Guest } from '../../types/database';
import { todayInZone } from '../../utils/dates';
import { formatDate, formatDateRange } from '../../utils/format';
import { GuestDialog } from './GuestsPage';

function AnonymizeDialog({ guest, onClose }: { guest: Guest; onClose: () => void }) {
  const { t } = useTranslation();
  const action = useAction(() => api.anonymizeGuest(guest.id, t('guests.anonymizedName')), onClose);
  return (
    <Modal title={t('guests.anonymizeTitle')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(undefined);
        }}
      >
        <Notice kind="warning">{t('guests.anonymizeExplain', { name: guest.full_name })}</Notice>
        <ErrorMessage error={action.error} />
        <FormActions onCancel={onClose} pending={action.pending} submitLabel={t('guests.anonymizeConfirm')} danger />
      </form>
    </Modal>
  );
}

export function GuestDetailPage() {
  const { guestId } = useParams();
  const { t } = useTranslation();
  const locale = useLocale();
  const { timeZone } = useApp();
  const guests = useGuests();
  const bookingsQuery = useBookings();
  const candidatesQuery = useCandidates();
  const paymentsQuery = usePayments();
  const [dialog, setDialog] = useState<'edit' | 'anonymize' | null>(null);
  const archive = useAction((archived: boolean) => api.setGuestArchived(guestId!, archived));
  const today = todayInZone(timeZone);

  return (
    <QueryGate queries={[guests, bookingsQuery, candidatesQuery, paymentsQuery]}>
      {() => {
        const guest = guests.data!.find((g) => g.id === guestId);
        if (!guest) return <Empty action={<Link to="/guests">{t('common.back')}</Link>}>{t('errors.NOT_FOUND')}</Empty>;
        const bookings = bookingsQuery.data!.filter((b) => b.guest_id === guest.id).sort((a, b) => b.start_date.localeCompare(a.start_date));
        const candidates = candidatesQuery.data!.filter((c) => c.guest_id === guest.id).sort((a, b) => b.start_date.localeCompare(a.start_date));
        const payments = paymentsQuery.data!.filter((p) => p.guest_id === guest.id);
        const upcoming = bookings.filter((b) => b.end_date > today && b.status !== 'cancelled');
        const previous = bookings.filter((b) => !upcoming.includes(b));
        const bookingList = (items: typeof bookings) => (
          <ul className="plain-list">
            {items.map((b) => (
              <li key={b.id} className="card-row">
                <Link to={`/bookings/${b.id}`}>{formatDateRange(b.start_date, b.end_date, locale)}</Link>
                <span className="badge-row">
                  <Money value={b.total_price} />
                  <StatusBadge group="booking" value={b.status} />
                </span>
              </li>
            ))}
          </ul>
        );
        return (
          <>
            <PageHeader
              back={
                <Link to="/guests" className="back-link">
                  ← {t('nav.guests')}
                </Link>
              }
              title={guest.full_name}
              actions={
                guest.anonymized_at ? null : (
                  <>
                    <button type="button" className="button" onClick={() => setDialog('edit')}>
                      {t('common.edit')}
                    </button>
                    <Link to={`/bookings/new?guest=${guest.id}`} className="button button-primary">
                      + {t('bookings.new')}
                    </Link>
                  </>
                )
              }
            />
            {guest.anonymized_at ? <Notice kind="info">{t('guests.anonymizedNotice', { date: formatDate(guest.anonymized_at.slice(0, 10), locale) })}</Notice> : null}
            <dl className="definition">
              <dt>{t('common.phone')}</dt>
              <dd>{guest.phone ? <PhoneLinks phone={guest.phone} /> : '—'}</dd>
              <dt>{t('common.email')}</dt>
              <dd>{guest.email ? <a href={`mailto:${guest.email}`}>{guest.email}</a> : '—'}</dd>
              <dt>{t('common.notes')}</dt>
              <dd className="pre-wrap">{guest.notes ?? '—'}</dd>
            </dl>
            <div className="stats">
              <Stat label={t('guests.bookingsCount')} value={guest.bookings_count} />
              <Stat label={t('guests.totalAgreed')} value={<Money value={guest.total_agreed} />} />
              <Stat label={t('guests.lastStay')} value={formatDate(guest.last_stay_end, locale)} />
            </div>
            <ErrorMessage error={archive.error} />

            <section className="section">
              <h2>{t('guests.upcomingBookings')}</h2>
              {upcoming.length === 0 ? <p className="muted">{t('common.none')}</p> : bookingList(upcoming)}
            </section>
            <section className="section">
              <h2>{t('guests.previousBookings')}</h2>
              {previous.length === 0 ? <p className="muted">{t('common.none')}</p> : bookingList(previous)}
            </section>
            <section className="section">
              <h2>{t('guests.candidateHistory')}</h2>
              {candidates.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <ul className="plain-list">
                  {candidates.map((c) => (
                    <li key={c.id} className="card-row">
                      <Link to={`/prospects/${c.booking_period_id}`}>{formatDateRange(c.start_date, c.end_date, locale)}</Link>
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
              <h2>{t('nav.payments')}</h2>
              {payments.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <ul className="plain-list">
                  {payments.map((p) => (
                    <li key={p.id} className={p.voided_at ? 'card-row row-voided' : 'card-row'}>
                      <Link to={`/bookings/${p.booking_id}`}>
                        {formatDate(p.payment_date, locale)} · {t(`paymentType.${p.payment_type}`)}
                      </Link>
                      <span className="badge-row">
                        <Money value={p.signed_amount} />
                        {p.voided_at ? <span className="badge badge-voided">{t('payments.voided')}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {guest.anonymized_at ? null : (
              <section className="section">
                <h2>{t('guests.dataTitle')}</h2>
                <p className="muted small">{t('guests.dataExplain')}</p>
                <div className="button-row">
                  <button type="button" className="button" disabled={archive.pending} onClick={() => archive.run(!guest.archived_at)}>
                    {guest.archived_at ? t('guests.unarchive') : t('guests.archive')}
                  </button>
                  <button type="button" className="button button-danger-outline" onClick={() => setDialog('anonymize')}>
                    {t('guests.anonymize')}
                  </button>
                </div>
              </section>
            )}
            {dialog === 'edit' ? <GuestDialog guest={guest} onClose={() => setDialog(null)} /> : null}
            {dialog === 'anonymize' ? <AnonymizeDialog guest={guest} onClose={() => setDialog(null)} /> : null}
          </>
        );
      }}
    </QueryGate>
  );
}

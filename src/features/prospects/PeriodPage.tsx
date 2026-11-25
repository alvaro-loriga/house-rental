import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { Empty, ErrorMessage, HoldDeadline, Money, Notice, PageHeader, PhoneLinks, QueryGate, StatusBadge } from '../../components/ui';
import { useAction, useBlocking, useBookings, useCandidates, useHolds, useLocale, usePeriods } from '../../hooks/data';
import * as api from '../../services/api';
import type { Candidate, Hold } from '../../types/database';
import { availabilityFor, overlappingCandidates } from '../../utils/availability';
import { nightsBetween } from '../../utils/dates';
import { formatDateRange, formatDateTime } from '../../utils/format';
import { CreateHoldDialog, ExtendHoldDialog, HoldHistoryDialog, ReleaseHoldDialog } from '../holds/HoldDialogs';
import { CandidateDialog, ConfirmCandidateDialog, EditPeriodDialog } from './ProspectDialogs';
import { AvailabilityBadge } from './ProspectsPage';

type Dialog =
  | { kind: 'add' }
  | { kind: 'editPeriod' }
  | { kind: 'edit'; candidate: Candidate }
  | { kind: 'hold'; candidate: Candidate }
  | { kind: 'confirm'; candidate: Candidate }
  | { kind: 'extend'; hold: Hold }
  | { kind: 'release'; hold: Hold }
  | { kind: 'history'; hold: Hold };

export function PeriodPage() {
  const { periodId } = useParams();
  const { t } = useTranslation();
  const locale = useLocale();
  const { properties, timeZone } = useApp();
  const periods = usePeriods();
  const candidatesQuery = useCandidates();
  const holdsQuery = useHolds();
  const blockingQuery = useBlocking();
  const bookingsQuery = useBookings();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const statusAction = useAction(({ id, status }: { id: string; status: 'discarded' | 'interested' }) => api.setCandidateStatus(id, status));
  const periodAction = useAction((status: 'open' | 'closed') => api.updatePeriod(periodId!, { status }));

  return (
    <QueryGate queries={[periods, candidatesQuery, holdsQuery, blockingQuery, bookingsQuery]}>
      {() => {
        const period = periods.data!.find((p) => p.id === periodId);
        if (!period) return <Empty action={<Link to="/prospects">{t('common.back')}</Link>}>{t('errors.NOT_FOUND')}</Empty>;
        const candidates = candidatesQuery.data!.filter((c) => c.booking_period_id === period.id);
        const holds = holdsQuery.data!.filter((h) => h.booking_period_id === period.id);
        const availability = availabilityFor(blockingQuery.data!, period.property_id, period.start_date, period.end_date);
        const overlapping = overlappingCandidates(candidatesQuery.data!, period.property_id, period.id, period.start_date, period.end_date);
        const booking = bookingsQuery.data!.find((b) => b.booking_period_id === period.id && b.status !== 'cancelled');
        const property = properties.find((p) => p.id === period.property_id);
        const effectiveHold = (candidateId: string) => holds.find((h) => h.candidate_id === candidateId && h.is_effective);
        const locked = Boolean(booking) || holds.some((h) => h.status === 'active');
        const holder = availability.blockers.find((b) => b.kind === 'hold');

        return (
          <>
            <PageHeader
              back={
                <Link to="/prospects" className="back-link">
                  ← {t('nav.prospects')}
                </Link>
              }
              title={formatDateRange(period.start_date, period.end_date, locale)}
              actions={
                <>
                  <button type="button" className="button" onClick={() => setDialog({ kind: 'editPeriod' })}>
                    {t('common.edit')}
                  </button>
                  {period.status === 'open' ? (
                    <button type="button" className="button" disabled={periodAction.pending} onClick={() => periodAction.run('closed')}>
                      {t('prospects.closePeriod')}
                    </button>
                  ) : period.status === 'closed' ? (
                    <button type="button" className="button" disabled={periodAction.pending} onClick={() => periodAction.run('open')}>
                      {t('prospects.reopenPeriod')}
                    </button>
                  ) : null}
                </>
              }
            />
            <div className="meta-row">
              <span>{property?.name}</span>
              <span>{t('common.nights', { count: nightsBetween(period.start_date, period.end_date) })}</span>
              <StatusBadge group="period" value={period.status} />
              <AvailabilityBadge availability={availability} ownCandidateIds={candidates.map((c) => c.id)} />
            </div>
            {period.notes ? <p className="muted">{period.notes}</p> : null}
            {booking ? (
              <Notice kind="success">
                {t('prospects.bookedNotice', { guest: booking.guest_name })} <Link to={`/bookings/${booking.id}`}>{t('prospects.viewBooking')}</Link>
              </Notice>
            ) : null}
            {!booking && availability.state === 'booked' ? <Notice kind="warning">{t('prospects.enquiryWarning.booked')}</Notice> : null}
            {holder && !candidates.some((c) => c.id === holder.candidate_id) ? (
              <Notice kind="warning">
                {t('prospects.heldBy', { guest: holder.guest_name })} <HoldDeadline expiresAt={holder.expires_at!} timeZone={timeZone} />
              </Notice>
            ) : null}
            <ErrorMessage error={statusAction.error ?? periodAction.error} />

            <section className="section">
              <div className="section-head">
                <h2>{t('prospects.candidates')}</h2>
                <button type="button" className="button button-primary" onClick={() => setDialog({ kind: 'add' })}>
                  + {t('prospects.addCandidate')}
                </button>
              </div>
              {candidates.length === 0 ? (
                <Empty>{t('prospects.noCandidates')}</Empty>
              ) : (
                <ul className="card-list">
                  {candidates.map((c) => {
                    const hold = effectiveHold(c.id);
                    const eligible = c.status !== 'confirmed' && c.status !== 'discarded';
                    return (
                      <li key={c.id} className={hold ? 'card card-held' : 'card'} data-testid={`candidate-${c.guest_name}`}>
                        <div className="card-row">
                          <Link to={`/guests/${c.guest_id}`} className="strong-link">
                            {c.guest_name}
                          </Link>
                          <Money value={c.proposed_price} className="money-strong" />
                        </div>
                        <div className="card-row">
                          <span className="badge-row">
                            <StatusBadge group="candidate" value={c.status} />
                            {hold ? (
                              <span className="badge badge-hold-active">
                                <span aria-hidden="true">⏳</span> {t('holds.badge')}
                              </span>
                            ) : null}
                          </span>
                          <PhoneLinks phone={c.guest_phone} />
                        </div>
                        {hold ? (
                          <p className="hold-line">
                            <HoldDeadline expiresAt={hold.expires_at} timeZone={hold.property_timezone} />
                          </p>
                        ) : null}
                        {c.notes ? <p className="muted small">{c.notes}</p> : null}
                        <div className="button-row">
                          {eligible ? (
                            <button type="button" className="button button-primary" onClick={() => setDialog({ kind: 'confirm', candidate: c })}>
                              {t('prospects.confirmAction')}
                            </button>
                          ) : null}
                          {eligible && !hold ? (
                            <button
                              type="button"
                              className="button button-hold"
                              disabled={availability.state !== 'free'}
                              title={availability.state !== 'free' ? t(`prospects.enquiryWarning.${availability.state}`) : undefined}
                              onClick={() => setDialog({ kind: 'hold', candidate: c })}
                            >
                              {t('holds.create')}
                            </button>
                          ) : null}
                          {hold ? (
                            <>
                              <button type="button" className="button" onClick={() => setDialog({ kind: 'extend', hold })}>
                                {t('holds.extend')}
                              </button>
                              <button type="button" className="button" onClick={() => setDialog({ kind: 'release', hold })}>
                                {t('holds.release')}
                              </button>
                            </>
                          ) : null}
                          {c.status !== 'confirmed' ? (
                            <button type="button" className="button" onClick={() => setDialog({ kind: 'edit', candidate: c })}>
                              {t('common.edit')}
                            </button>
                          ) : null}
                          {eligible && !hold ? (
                            <button type="button" className="button" disabled={statusAction.pending} onClick={() => statusAction.run({ id: c.id, status: 'discarded' })}>
                              {t('prospects.discard')}
                            </button>
                          ) : null}
                          {c.status === 'discarded' ? (
                            <button type="button" className="button" disabled={statusAction.pending} onClick={() => statusAction.run({ id: c.id, status: 'interested' })}>
                              {t('prospects.restore')}
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {overlapping.length > 0 ? (
              <section className="section">
                <h2>{t('prospects.overlapTitle')}</h2>
                <ul className="plain-list">
                  {overlapping.map((c) => (
                    <li key={c.id}>
                      <Link to={`/prospects/${c.booking_period_id}`}>
                        {c.guest_name} · {formatDateRange(c.start_date, c.end_date, locale)}
                      </Link>{' '}
                      <StatusBadge group="candidate" value={c.status} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {holds.length > 0 ? (
              <section className="section">
                <h2>{t('holds.historySection')}</h2>
                <ul className="plain-list">
                  {holds.map((h) => (
                    <li key={h.id} className="card-row">
                      <span>
                        {h.guest_name} · <StatusBadge group="hold" value={h.effective_status} />{' '}
                        <span className="muted small">{formatDateTime(h.expires_at, locale, h.property_timezone)}</span>
                      </span>
                      <button type="button" className="link-button" onClick={() => setDialog({ kind: 'history', hold: h })}>
                        {t('common.history')}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {dialog?.kind === 'add' ? (
              <CandidateDialog period={period} existingGuestIds={candidates.map((c) => c.guest_id)} availability={availability} onClose={close} />
            ) : null}
            {dialog?.kind === 'edit' ? (
              <CandidateDialog period={period} candidate={dialog.candidate} existingGuestIds={[]} availability={availability} onClose={close} />
            ) : null}
            {dialog?.kind === 'editPeriod' ? <EditPeriodDialog period={period} locked={locked} onClose={close} /> : null}
            {dialog?.kind === 'hold' ? (
              <CreateHoldDialog
                target={{
                  candidateId: dialog.candidate.id,
                  guestName: dialog.candidate.guest_name,
                  propertyId: period.property_id,
                  startDate: period.start_date,
                  endDate: period.end_date,
                }}
                onClose={close}
              />
            ) : null}
            {dialog?.kind === 'confirm' ? (
              <ConfirmCandidateDialog
                candidate={dialog.candidate}
                others={candidates.filter((c) => c.id !== dialog.candidate.id)}
                overlapping={overlapping}
                availability={availability}
                onClose={close}
              />
            ) : null}
            {dialog?.kind === 'extend' ? <ExtendHoldDialog hold={dialog.hold} onClose={close} /> : null}
            {dialog?.kind === 'release' ? <ReleaseHoldDialog hold={dialog.hold} onClose={close} /> : null}
            {dialog?.kind === 'history' ? <HoldHistoryDialog hold={dialog.hold} onClose={close} /> : null}
          </>
        );
      }}
    </QueryGate>
  );
}

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { Empty, HoldDeadline, Money, PageHeader, QueryGate, StatusBadge } from '../../components/ui';
import { useBlocking, useCandidates, useLocale, usePeriods } from '../../hooks/data';
import type { Blocking, Candidate, Period } from '../../types/database';
import { availabilityFor, type Availability } from '../../utils/availability';
import { todayInZone } from '../../utils/dates';
import { formatDateRange } from '../../utils/format';
import { matchesContact } from '../../utils/phone';
import { NewPeriodDialog } from './ProspectDialogs';

export function AvailabilityBadge({ availability, ownCandidateIds = [] }: { availability: Availability; ownCandidateIds?: string[] }) {
  const { t } = useTranslation();
  const { timeZone } = useApp();
  const blocker: Blocking | undefined = availability.blockers[0];
  if (availability.state === 'free') {
    return (
      <span className="badge badge-avail-free">
        <span aria-hidden="true">○</span> {t('availability.free')}
      </span>
    );
  }
  if (availability.state === 'booked') {
    return (
      <span className="badge badge-avail-booked">
        <span aria-hidden="true">■</span> {t('availability.bookedBy', { guest: blocker.guest_name })}
      </span>
    );
  }
  const own = blocker.candidate_id != null && ownCandidateIds.includes(blocker.candidate_id);
  return (
    <span className="badge badge-avail-held">
      <span aria-hidden="true">⏳</span> {t(own ? 'availability.heldFor' : 'availability.heldBy', { guest: blocker.guest_name })} ·{' '}
      <HoldDeadline expiresAt={blocker.expires_at!} timeZone={timeZone} compact />
    </span>
  );
}

function PeriodCard({ period, candidates, blocking, propertyName }: { period: Period; candidates: Candidate[]; blocking: Blocking[]; propertyName: string | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const availability = availabilityFor(blocking, period.property_id, period.start_date, period.end_date);
  const open = candidates.filter((c) => c.status !== 'discarded');
  return (
    <li className="card">
      <Link to={`/prospects/${period.id}`} className="card-link">
        <div className="card-row">
          <strong>{formatDateRange(period.start_date, period.end_date, locale)}</strong>
          <StatusBadge group="period" value={period.status} />
        </div>
        {propertyName ? <div className="muted small">{propertyName}</div> : null}
        <div className="card-row">
          <AvailabilityBadge availability={availability} ownCandidateIds={candidates.map((c) => c.id)} />
          <span className="muted small">{t('prospects.candidateCount', { count: open.length })}</span>
        </div>
        {open.length > 0 ? (
          <ul className="mini-list">
            {open.map((c) => (
              <li key={c.id}>
                <span>{c.guest_name}</span>
                <Money value={c.proposed_price} />
                <StatusBadge group="candidate" value={c.status} />
              </li>
            ))}
          </ul>
        ) : null}
        {period.notes ? <p className="muted small">{period.notes}</p> : null}
      </Link>
    </li>
  );
}

export function ProspectsPage() {
  const { t } = useTranslation();
  const { inScope, properties, timeZone } = useApp();
  const periods = usePeriods();
  const candidates = useCandidates();
  const blocking = useBlocking();
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const [query, setQuery] = useState('');
  const creating = params.get('new') === '1';
  const today = todayInZone(timeZone);

  const byPeriod = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const c of candidates.data ?? []) map.set(c.booking_period_id, [...(map.get(c.booking_period_id) ?? []), c]);
    return map;
  }, [candidates.data]);

  const visible = (periods.data ?? []).filter((p) => {
    if (!inScope(p.property_id)) return false;
    if (scope === 'open' && (p.status !== 'open' || p.end_date <= today)) return false;
    if (!query.trim()) return true;
    return (byPeriod.get(p.id) ?? []).some((c) => matchesContact({ id: c.guest_id, full_name: c.guest_name, phone: c.guest_phone, email: c.guest_email }, query));
  });

  const openDialog = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set('new', '1');
    else {
      next.delete('new');
      next.delete('start');
      next.delete('end');
    }
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('nav.prospects')}
        actions={
          <button type="button" className="button button-primary" onClick={() => openDialog(true)}>
            + {t('prospects.newPeriod')}
          </button>
        }
      />
      <div className="toolbar">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('prospects.searchPlaceholder')} aria-label={t('common.search')} />
        <select value={scope} onChange={(e) => setScope(e.target.value as 'open' | 'all')} aria-label={t('common.filter')}>
          <option value="open">{t('prospects.filter.open')}</option>
          <option value="all">{t('prospects.filter.all')}</option>
        </select>
      </div>
      <p className="muted small">{t('prospects.nonBlockingHint')}</p>
      <QueryGate queries={[periods, candidates, blocking]}>
        {() =>
          visible.length === 0 ? (
            <Empty>{t('prospects.empty')}</Empty>
          ) : (
            <ul className="card-list">
              {visible.map((p) => (
                <PeriodCard
                  key={p.id}
                  period={p}
                  candidates={byPeriod.get(p.id) ?? []}
                  blocking={blocking.data ?? []}
                  propertyName={properties.length > 1 ? (properties.find((x) => x.id === p.property_id)?.name ?? null) : null}
                />
              ))}
            </ul>
          )
        }
      </QueryGate>
      {creating ? <NewPeriodDialog onClose={() => openDialog(false)} initialStart={params.get('start') ?? ''} initialEnd={params.get('end') ?? ''} /> : null}
    </>
  );
}

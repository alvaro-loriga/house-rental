import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { HoldDeadline, Money, PageHeader, QueryGate, StatusBadge } from '../../components/ui';
import { useBlocking, useBookings, useCandidates, useHolds, useLocale, usePeriods } from '../../hooks/data';
import type { Blocking, Booking, Candidate, Hold, Period } from '../../types/database';
import { addDays, isNightOf, monthGrid, todayInZone, type ISODate } from '../../utils/dates';
import { formatDate, formatDateLong, formatDateRange, formatDateTime, formatMonthYear, monthName, weekdayNames } from '../../utils/format';

export type DayState = 'free' | 'booked' | 'completed' | 'held';

export interface DayInfo {
  state: DayState;
  /** Booking or effective hold occupying the night that starts on this day. */
  blocker: Blocking | null;
  /** A stay that checks out this morning (the day itself is not one of its nights). */
  checkout: Blocking | null;
  isCheckIn: boolean;
  /** Open potential periods whose nights include this day (they never block). */
  periods: Period[];
  candidateCount: number;
}

/** What a calendar day shows, for one property. Pure, so it can be unit-tested. */
export function describeDay(day: ISODate, propertyId: string, blocking: Blocking[], periods: Period[], candidates: Candidate[]): DayInfo {
  const mine = blocking.filter((b) => b.property_id === propertyId);
  const blocker = mine.find((b) => isNightOf(day, b.start_date, b.end_date)) ?? null;
  const checkout = mine.find((b) => b.end_date === day) ?? null;
  const open = periods.filter((p) => p.property_id === propertyId && p.status === 'open' && isNightOf(day, p.start_date, p.end_date));
  const ids = new Set(open.map((p) => p.id));
  const candidateCount = candidates.filter((c) => ids.has(c.booking_period_id) && c.status !== 'discarded' && c.status !== 'confirmed').length;
  const state: DayState = !blocker ? 'free' : blocker.kind === 'hold' ? 'held' : blocker.booking_status === 'completed' ? 'completed' : 'booked';
  return { state, blocker, checkout, isCheckIn: blocker?.start_date === day, periods: open, candidateCount };
}

const STATE_ICON: Record<DayState, string> = { free: '', booked: '✓', completed: '✓✓', held: '⏳' };

function MonthGrid({ year, month, today, selected, onSelect, info, mini }: { year: number; month: number; today: ISODate; selected: ISODate | null; onSelect: (day: ISODate) => void; info: (day: ISODate) => DayInfo; mini?: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const weekdays = weekdayNames(locale);
  return (
    <table className={mini ? 'calendar calendar-mini' : 'calendar'}>
      {mini ? <caption>{monthName(month, locale)}</caption> : <caption className="visually-hidden">{formatMonthYear(year, month, locale)}</caption>}
      <thead>
        <tr>
          {weekdays.map((name) => (
            <th key={name} scope="col">
              {mini ? name.charAt(0).toUpperCase() : name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {monthGrid(year, month).map((week, i) => (
          <tr key={i}>
            {week.map((day, j) => {
              if (!day) return <td key={j} className="day-empty" />;
              const d = info(day);
              const label = [
                formatDateLong(day, locale),
                t(`calendar.state.${d.state}`),
                d.blocker ? d.blocker.guest_name : '',
                d.checkout ? t('calendar.checkoutOf', { guest: d.checkout.guest_name }) : '',
                d.candidateCount > 0 ? t('calendar.candidates', { count: d.candidateCount }) : '',
              ]
                .filter(Boolean)
                .join(', ');
              const classes = ['day', `day-${d.state}`, d.isCheckIn ? 'day-checkin' : '', d.checkout && d.state === 'free' ? 'day-checkout' : '', day === today ? 'day-today' : '', day === selected ? 'day-selected' : '']
                .filter(Boolean)
                .join(' ');
              return (
                <td key={j}>
                  <button type="button" className={classes} aria-label={label} aria-pressed={day === selected} onClick={() => onSelect(day)} data-date={day} data-state={d.state}>
                    <span className="day-number">{Number(day.slice(8))}</span>
                    {mini ? null : (
                      <span className="day-marks" aria-hidden="true">
                        {d.state !== 'free' ? <span className="day-icon">{STATE_ICON[d.state]}</span> : null}
                        {d.isCheckIn && d.blocker ? <span className="day-name">{d.blocker.guest_name.split(' ')[0]}</span> : null}
                        {d.checkout && d.state === 'free' ? <span className="day-out">↗</span> : null}
                        {d.candidateCount > 0 ? <span className="day-candidates">{d.candidateCount}?</span> : null}
                      </span>
                    )}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayDetails({ day, info, bookings, holds, candidates }: { day: ISODate; info: DayInfo; bookings: Booking[]; holds: Hold[]; candidates: Candidate[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { timeZone } = useApp();
  const booking = info.blocker?.booking_id ? bookings.find((b) => b.id === info.blocker!.booking_id) : undefined;
  const hold = info.blocker?.hold_id ? holds.find((h) => h.id === info.blocker!.hold_id) : undefined;
  const pastHolds = holds.filter((h) => !h.is_effective && h.status !== 'converted' && isNightOf(day, h.start_date, h.end_date));
  return (
    <section className="card day-details" aria-live="polite" data-testid="day-details">
      <h2>{formatDateLong(day, locale)}</h2>
      <p>
        <strong>{t(`calendar.nightState.${info.state}`)}</strong>
      </p>
      {info.checkout ? <p className="muted">{t('calendar.checkoutExplain', { guest: info.checkout.guest_name })}</p> : null}
      {booking ? (
        <div className="summary-box">
          <div className="card-row">
            <Link to={`/bookings/${booking.id}`} className="strong-link">
              {booking.guest_name}
            </Link>
            <StatusBadge group="booking" value={booking.status} />
          </div>
          <p>{formatDateRange(booking.start_date, booking.end_date, locale)}</p>
          <div className="card-row">
            <span>
              {t('common.total')}: <Money value={booking.total_price} />
            </span>
            <span>
              {t('common.outstanding')}: <Money value={booking.outstanding} className="money-strong" />
            </span>
          </div>
        </div>
      ) : null}
      {hold ? (
        <div className="summary-box summary-hold">
          <div className="card-row">
            <Link to={`/prospects/${hold.booking_period_id}`} className="strong-link">
              {t('availability.heldFor', { guest: hold.guest_name })}
            </Link>
            <StatusBadge group="hold" value="active" />
          </div>
          <p>{formatDateRange(hold.start_date, hold.end_date, locale)}</p>
          <p className="hold-line">
            <HoldDeadline expiresAt={hold.expires_at} timeZone={timeZone} />
          </p>
        </div>
      ) : null}
      {info.periods.length > 0 ? (
        <>
          <h3>{t('calendar.periodsTitle')}</h3>
          <ul className="plain-list">
            {info.periods.map((p) => (
              <li key={p.id}>
                <Link to={`/prospects/${p.id}`}>{formatDateRange(p.start_date, p.end_date, locale)}</Link>
                <ul className="mini-list">
                  {candidates
                    .filter((c) => c.booking_period_id === p.id && c.status !== 'discarded')
                    .map((c) => (
                      <li key={c.id}>
                        <span>{c.guest_name}</span>
                        <Money value={c.proposed_price} />
                        <StatusBadge group="candidate" value={c.status} />
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pastHolds.length > 0 ? (
        <>
          <h3>{t('calendar.pastHolds')}</h3>
          <ul className="plain-list small">
            {pastHolds.map((h) => (
              <li key={h.id}>
                {h.guest_name} · <StatusBadge group="hold" value={h.effective_status} /> · {formatDateTime(h.expires_at, locale, timeZone)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="button-row">
        <Link to={`/prospects?new=1&start=${day}&end=${addDays(day, 7)}`} className="button">
          + {t('prospects.newPeriod')}
        </Link>
        {info.state === 'free' ? (
          <Link to={`/bookings/new?start=${day}&end=${addDays(day, 7)}`} className="button">
            + {t('bookings.new')}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

export function CalendarPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { properties, selectedProperty, setPropertyFilter, timeZone } = useApp();
  const blockingQuery = useBlocking();
  const periodsQuery = usePeriods();
  const candidatesQuery = useCandidates();
  const bookingsQuery = useBookings();
  const holdsQuery = useHolds();
  const today = todayInZone(timeZone);
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));
  const [view, setView] = useState<'month' | 'year'>('month');
  const [selected, setSelected] = useState<ISODate | null>(null);
  // A calendar is always for one property: fall back to the first when "all" is selected.
  const property = selectedProperty ?? properties[0];

  const info = useMemo(() => {
    const cache = new Map<ISODate, DayInfo>();
    return (day: ISODate) => {
      let value = cache.get(day);
      if (!value) {
        value = describeDay(day, property?.id ?? '', blockingQuery.data ?? [], periodsQuery.data ?? [], candidatesQuery.data ?? []);
        cache.set(day, value);
      }
      return value;
    };
  }, [property?.id, blockingQuery.data, periodsQuery.data, candidatesQuery.data]);

  const move = (delta: number) =>
    setCursor(({ year, month }) => {
      if (view === 'year') return { year: year + delta, month };
      const index = year * 12 + (month - 1) + delta;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    });
  const goToday = () => {
    setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
    setSelected(today);
  };
  const title = view === 'year' ? String(cursor.year) : formatMonthYear(cursor.year, cursor.month, locale);

  return (
    <>
      <PageHeader title={t('nav.calendar')} />
      <div className="toolbar calendar-toolbar">
        {properties.length > 1 ? (
          <select value={property?.id ?? ''} onChange={(e) => setPropertyFilter(e.target.value)} aria-label={t('common.property')}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="calendar-nav">
          <button type="button" className="button" onClick={() => move(-1)} aria-label={t(view === 'year' ? 'calendar.prevYear' : 'calendar.prevMonth')}>
            ‹
          </button>
          <strong className="calendar-title" aria-live="polite">
            {title}
          </strong>
          <button type="button" className="button" onClick={() => move(1)} aria-label={t(view === 'year' ? 'calendar.nextYear' : 'calendar.nextMonth')}>
            ›
          </button>
        </div>
        <button type="button" className="button" onClick={goToday}>
          {t('common.today')}
        </button>
        <div className="segmented" role="group" aria-label={t('calendar.view')}>
          <button type="button" className={view === 'month' ? 'active' : ''} aria-pressed={view === 'month'} onClick={() => setView('month')}>
            {t('calendar.month')}
          </button>
          <button type="button" className={view === 'year' ? 'active' : ''} aria-pressed={view === 'year'} onClick={() => setView('year')}>
            {t('calendar.year')}
          </button>
        </div>
      </div>
      <QueryGate queries={[blockingQuery, periodsQuery, candidatesQuery, bookingsQuery, holdsQuery]}>
        {() => (
          <>
            {view === 'month' ? (
              <MonthGrid year={cursor.year} month={cursor.month} today={today} selected={selected} onSelect={setSelected} info={info} />
            ) : (
              <div className="year-grid">
                {Array.from({ length: 12 }, (_, i) => (
                  <MonthGrid
                    key={i}
                    mini
                    year={cursor.year}
                    month={i + 1}
                    today={today}
                    selected={selected}
                    info={info}
                    onSelect={(day) => {
                      setSelected(day);
                      setCursor({ year: cursor.year, month: i + 1 });
                      setView('month');
                    }}
                  />
                ))}
              </div>
            )}
            <ul className="legend" aria-label={t('calendar.legend')}>
              <li>
                <span className="swatch day-free" /> {t('calendar.state.free')}
              </li>
              <li>
                <span className="swatch day-booked">✓</span> {t('calendar.state.booked')}
              </li>
              <li>
                <span className="swatch day-held">⏳</span> {t('calendar.state.held')}
              </li>
              <li>
                <span className="swatch day-completed">✓✓</span> {t('calendar.state.completed')}
              </li>
              <li>
                <span className="swatch swatch-text">2?</span> {t('calendar.legendCandidates')}
              </li>
              <li>
                <span className="swatch swatch-text">↗</span> {t('calendar.legendCheckout')}
              </li>
            </ul>
            {selected ? (
              <DayDetails
                day={selected}
                info={info(selected)}
                bookings={bookingsQuery.data ?? []}
                holds={(holdsQuery.data ?? []).filter((h) => h.property_id === property?.id)}
                candidates={candidatesQuery.data ?? []}
              />
            ) : (
              <p className="muted">{t('calendar.selectHint', { date: formatDate(today, locale) })}</p>
            )}
          </>
        )}
      </QueryGate>
    </>
  );
}

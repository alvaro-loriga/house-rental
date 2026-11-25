import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { Empty, Money, PageHeader, PhoneLinks, QueryGate, StatusBadge } from '../../components/ui';
import { useBookings, useLocale } from '../../hooks/data';
import type { Booking } from '../../types/database';
import { todayInZone } from '../../utils/dates';
import { formatDate } from '../../utils/format';
import { matchesContact } from '../../utils/phone';

const FILTERS = ['all', 'upcoming', 'past', 'confirmed', 'provisional', 'completed', 'cancelled', 'outstanding', 'overdue'] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = ['checkInAsc', 'checkInDesc', 'guest', 'outstanding'] as const;
type Sort = (typeof SORTS)[number];

export function filterBookings(bookings: Booking[], filter: Filter, today: string): Booking[] {
  switch (filter) {
    case 'upcoming':
      return bookings.filter((b) => b.end_date > today && b.status !== 'cancelled');
    case 'past':
      return bookings.filter((b) => b.end_date <= today);
    case 'outstanding':
      return bookings.filter((b) => (b.status === 'confirmed' || b.status === 'completed') && b.outstanding > 0);
    case 'overdue':
      return bookings.filter((b) => b.overdue > 0);
    case 'all':
      return bookings;
    default:
      return bookings.filter((b) => b.status === filter);
  }
}

export function BookingsPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { inScope, properties, timeZone } = useApp();
  const bookings = useBookings();
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [sort, setSort] = useState<Sort>('checkInAsc');
  const [query, setQuery] = useState('');
  const today = todayInZone(timeZone);
  const showProperty = properties.length > 1;

  const rows = useMemo(() => {
    const scoped = (bookings.data ?? []).filter((b) => inScope(b.property_id));
    const searched = filterBookings(scoped, filter, today).filter((b) =>
      matchesContact({ id: b.guest_id, full_name: b.guest_name, phone: b.guest_phone, email: b.guest_email }, query),
    );
    const sorters: Record<Sort, (a: Booking, b: Booking) => number> = {
      checkInAsc: (a, b) => a.start_date.localeCompare(b.start_date),
      checkInDesc: (a, b) => b.start_date.localeCompare(a.start_date),
      guest: (a, b) => a.guest_name.localeCompare(b.guest_name, locale),
      outstanding: (a, b) => b.outstanding - a.outstanding,
    };
    return [...searched].sort(sorters[sort]);
  }, [bookings.data, inScope, filter, today, query, sort, locale]);

  return (
    <>
      <PageHeader
        title={t('nav.bookings')}
        actions={
          <Link to="/bookings/new" className="button button-primary">
            + {t('bookings.new')}
          </Link>
        }
      />
      <div className="toolbar">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('bookings.searchPlaceholder')} aria-label={t('common.search')} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label={t('common.filter')}>
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`bookings.filter.${f}`)}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('common.sort')}>
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`bookings.sort.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <QueryGate queries={[bookings]}>
        {() =>
          rows.length === 0 ? (
            <Empty action={<Link to="/bookings/new">{t('bookings.new')}</Link>}>{t('bookings.empty')}</Empty>
          ) : (
            <table className="rtable">
              <thead>
                <tr>
                  <th>{t('common.dates')}</th>
                  <th>{t('common.guest')}</th>
                  {showProperty ? <th>{t('common.property')}</th> : null}
                  <th>{t('common.status')}</th>
                  <th className="num">{t('common.total')}</th>
                  <th className="num">{t('common.paid')}</th>
                  <th className="num">{t('common.outstanding')}</th>
                  <th>{t('common.phone')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td data-label={t('common.dates')}>
                      <Link to={`/bookings/${b.id}`} className="strong-link">
                        {formatDate(b.start_date, locale)} – {formatDate(b.end_date, locale)}
                      </Link>
                    </td>
                    <td data-label={t('common.guest')}>{b.guest_name}</td>
                    {showProperty ? <td data-label={t('common.property')}>{b.property_name}</td> : null}
                    <td data-label={t('common.status')}>
                      <StatusBadge group="booking" value={b.status} />
                    </td>
                    <td data-label={t('common.total')} className="num">
                      <Money value={b.total_price} />
                    </td>
                    <td data-label={t('common.paid')} className="num">
                      <Money value={b.net_paid} />
                    </td>
                    <td data-label={t('common.outstanding')} className="num">
                      <Money value={b.outstanding} className={b.overdue > 0 ? 'money-strong money-danger' : 'money-strong'} />
                      {b.overdue > 0 ? <span className="badge badge-overdue">{t('common.overdue')}</span> : null}
                    </td>
                    <td data-label={t('common.phone')}>
                      <PhoneLinks phone={b.guest_phone} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryGate>
    </>
  );
}

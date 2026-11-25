import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext';
import { Money, PageHeader, QueryGate, Stat } from '../../components/ui';
import { useBookings, useLocale, usePayments } from '../../hooks/data';
import { todayInZone } from '../../utils/dates';
import { buildYearReport } from '../../utils/finance';
import { formatMoney, formatPercent, monthName } from '../../utils/format';

export function ReportsPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { inScope, properties, propertyFilter, selectedProperty, timeZone } = useApp();
  const bookingsQuery = useBookings();
  const paymentsQuery = usePayments();
  const currentYear = Number(todayInZone(timeZone).slice(0, 4));
  const [year, setYear] = useState(currentYear);

  const years = useMemo(() => {
    const set = new Set<number>([currentYear]);
    for (const b of bookingsQuery.data ?? []) {
      set.add(Number(b.start_date.slice(0, 4)));
      set.add(Number(b.end_date.slice(0, 4)));
    }
    for (const p of paymentsQuery.data ?? []) set.add(Number(p.payment_date.slice(0, 4)));
    return [...set].sort((a, b) => b - a);
  }, [bookingsQuery.data, paymentsQuery.data, currentYear]);

  return (
    <>
      <PageHeader title={t('nav.reports')} />
      <div className="toolbar">
        <label className="inline-field">
          {t('common.year')}
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">{propertyFilter === 'all' ? t('reports.scopeAll', { count: properties.length }) : t('reports.scopeOne', { name: selectedProperty?.name })}</span>
      </div>
      <QueryGate queries={[bookingsQuery, paymentsQuery]}>
        {() => {
          const report = buildYearReport(
            bookingsQuery.data!.filter((b) => inScope(b.property_id)),
            paymentsQuery.data!.filter((p) => inScope(p.property_id)),
            year,
            propertyFilter === 'all' ? properties.length : 1,
          );
          const max = Math.max(1, ...report.monthlyNet.map((v) => Math.abs(v)));
          return (
            <>
              <section className="section">
                <h2>{t('reports.bookingValue')}</h2>
                <div className="stats">
                  <Stat label={t('reports.agreedValue', { year })} value={<Money value={report.agreedValue} />} help={t('reports.help.agreedValue')} />
                  <Stat label={t('reports.bookingsCount')} value={report.bookingsCount} help={t('reports.help.bookingsCount')} />
                  <Stat label={t('reports.occupiedNights')} value={report.occupiedNights} help={t('reports.help.occupiedNights', { available: report.availableNights })} />
                  <Stat label={t('reports.occupancy')} value={formatPercent(report.occupancy, locale)} help={t('reports.help.occupancy')} />
                  <Stat label={t('reports.averagePerNight')} value={<Money value={report.averagePerNight} />} help={t('reports.help.averagePerNight')} />
                </div>
              </section>
              <section className="section">
                <h2>{t('reports.cash')}</h2>
                <div className="stats">
                  <Stat label={t('payments.netReceipts')} value={<Money value={report.netReceipts} />} tone="good" help={t('reports.help.netReceipts')} />
                  <Stat label={t('payments.receipts')} value={<Money value={report.receipts} />} />
                  <Stat label={t('payments.refunds')} value={<Money value={report.refunds} />} />
                </div>
                <table className="bars" data-testid="monthly-net">
                  <caption>{t('reports.monthlyNet', { year })}</caption>
                  <tbody>
                    {report.monthlyNet.map((value, i) => (
                      <tr key={i}>
                        <th scope="row">{monthName(i + 1, locale, 'short')}</th>
                        <td className="bar-cell">
                          <span className={value < 0 ? 'bar bar-negative' : 'bar'} style={{ width: `${(Math.abs(value) / max) * 100}%` }} />
                        </td>
                        <td className="num">{formatMoney(value, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="section">
                <h2>{t('reports.pending')}</h2>
                <div className="stats">
                  <Stat label={t('common.outstanding')} value={<Money value={report.outstanding} />} tone={report.outstanding > 0 ? 'warn' : undefined} help={t('reports.help.outstanding')} />
                  <Stat label={t('common.overdue')} value={<Money value={report.overdue} />} tone={report.overdue > 0 ? 'danger' : undefined} help={t('reports.help.overdue')} />
                </div>
              </section>
              <p className="muted small">{t('reports.disclaimer')}</p>
            </>
          );
        }}
      </QueryGate>
    </>
  );
}

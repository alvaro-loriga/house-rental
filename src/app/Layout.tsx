import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { useHolds, useLocale } from '../hooks/data';
import { refreshEverything } from '../lib/queryClient';
import { LOCALES } from '../utils/format';
import { useApp } from './AppContext';

const PRIMARY = [
  { to: '/', key: 'dashboard', icon: '⌂' },
  { to: '/calendar', key: 'calendar', icon: '▦' },
  { to: '/bookings', key: 'bookings', icon: '✓' },
  { to: '/prospects', key: 'prospects', icon: '?' },
  { to: '/payments', key: 'payments', icon: '€' },
] as const;
const SECONDARY = [
  { to: '/guests', key: 'guests', icon: '☺' },
  { to: '/reports', key: 'reports', icon: '∑' },
  { to: '/settings', key: 'settings', icon: '⚙' },
] as const;

export function LanguageSwitch({ onChange }: { onChange: (locale: (typeof LOCALES)[number]) => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <div className="language-switch" role="group" aria-label={t('settings.language')}>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          className={code === locale ? 'active' : ''}
          aria-pressed={code === locale}
          lang={code.slice(0, 2)}
          title={t(`language.${code}`)}
          onClick={() => onChange(code)}
        >
          {code.slice(0, 2).toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** Refetches the moment the next effective hold reaches its deadline, and when the app resumes. */
function useAvailabilityRefresh() {
  const holds = useHolds();
  const nextDeadline = (holds.data ?? [])
    .filter((h) => h.is_effective)
    .map((h) => new Date(h.expires_at).getTime())
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (!nextDeadline) return;
    // setTimeout cannot wait longer than ~24.8 days; the periodic refetch covers that case.
    const delay = Math.min(Math.max(nextDeadline - Date.now() + 750, 0), 2_000_000_000);
    const id = setTimeout(() => void refreshEverything(), delay);
    return () => clearTimeout(id);
  }, [nextDeadline]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshEverything();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, []);
}

export function Layout() {
  const { t } = useTranslation();
  const { workspace, properties, propertyFilter, setPropertyFilter, setLocale } = useApp();
  const { signOut } = useAuth();
  const online = useOnline();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useAvailabilityRefresh();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const link = (item: { to: string; key: string; icon: string }) => (
    <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
      <span className="nav-icon" aria-hidden="true">
        {item.icon}
      </span>
      <span className="nav-text">{t(`nav.${item.key}`)}</span>
    </NavLink>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('nav.skipToContent')}
      </a>
      <header className="topbar">
        <div className="brand" title={workspace.name}>
          {workspace.name}
        </div>
        {properties.length > 1 ? (
          <select className="property-select" value={propertyFilter} onChange={(e) => setPropertyFilter(e.target.value)} aria-label={t('common.property')}>
            <option value="all">{t('common.allProperties')}</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="property-name">{properties[0]?.name}</span>
        )}
        <LanguageSwitch onChange={setLocale} />
        <button type="button" className="icon-button menu-button" aria-expanded={menuOpen} aria-controls="more-menu" onClick={() => setMenuOpen((v) => !v)}>
          <span aria-hidden="true">☰</span>
          <span className="visually-hidden">{t('nav.more')}</span>
        </button>
      </header>
      {menuOpen ? (
        <nav id="more-menu" className="more-menu" aria-label={t('nav.more')}>
          {SECONDARY.map(link)}
          <button type="button" className="nav-link" onClick={() => void signOut()}>
            <span className="nav-icon" aria-hidden="true">
              ⎋
            </span>
            <span className="nav-text">{t('nav.signOut')}</span>
          </button>
        </nav>
      ) : null}
      <nav className="sidenav" aria-label={t('nav.main')}>
        {PRIMARY.map(link)}
        {SECONDARY.map(link)}
      </nav>
      {!online ? (
        <p className="offline-banner" role="alert">
          {t('offline.banner')}
        </p>
      ) : null}
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="bottomnav" aria-label={t('nav.main')}>
        {PRIMARY.map(link)}
      </nav>
    </div>
  );
}

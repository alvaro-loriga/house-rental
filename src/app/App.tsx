import { QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../features/auth/AuthContext';
import { AuthShell, LoginPage } from '../features/auth/LoginPage';
import { BookingDetailPage } from '../features/bookings/BookingDetailPage';
import { BookingsPage } from '../features/bookings/BookingsPage';
import { NewBookingPage } from '../features/bookings/NewBookingPage';
import { CalendarPage } from '../features/calendar/CalendarPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { GuestDetailPage } from '../features/guests/GuestDetailPage';
import { GuestsPage } from '../features/guests/GuestsPage';
import { PaymentsPage } from '../features/payments/PaymentsPage';
import { PeriodPage } from '../features/prospects/PeriodPage';
import { ProspectsPage } from '../features/prospects/ProspectsPage';
import { ReportsPage } from '../features/reporting/ReportsPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { useBasicErrorText } from '../hooks/data';
import { queryClient } from '../lib/queryClient';
import { AppProvider } from './AppContext';
import { Layout } from './Layout';

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="state state-full" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {t('common.loading')}
    </div>
  );
}

function Gatekeeper() {
  const { t } = useTranslation();
  const { user, loading, signOut } = useAuth();
  const errorText = useBasicErrorText();
  if (loading) return <Loading />;
  if (!user) return <LoginPage />;
  return (
    <AppProvider
      key={user.id}
      fallback={(gate) => {
        if (gate.state === 'loading') return <Loading />;
        if (gate.state === 'ready') return null;
        return (
          <AuthShell>
            {gate.state === 'no-access' ? (
              <>
                <h2>{t('auth.noAccessTitle')}</h2>
                <p>{t('auth.noAccessBody', { email: user.email ?? '' })}</p>
              </>
            ) : (
              <>
                <p className="alert alert-error" role="alert">
                  {errorText(gate.error)}
                </p>
                <button type="button" className="button button-primary button-block" onClick={gate.retry}>
                  {t('common.retry')}
                </button>
              </>
            )}
            <button type="button" className="button button-block" onClick={() => void signOut()}>
              {t('nav.signOut')}
            </button>
          </AuthShell>
        );
      }}
    >
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="bookings/new" element={<NewBookingPage />} />
          <Route path="bookings/:bookingId" element={<BookingDetailPage />} />
          <Route path="prospects" element={<ProspectsPage />} />
          <Route path="prospects/:periodId" element={<PeriodPage />} />
          <Route path="guests" element={<GuestsPage />} />
          <Route path="guests/:guestId" element={<GuestDetailPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Gatekeeper />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

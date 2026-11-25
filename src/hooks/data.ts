import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../app/AppContext';
import { refreshEverything } from '../lib/queryClient';
import * as api from '../services/api';
import { AppError, toAppError } from '../utils/errors';
import { describeDeadline, formatDate, toLocale, type AppLocale } from '../utils/format';

// --- Queries -------------------------------------------------------------------
function useWorkspaceQuery<T>(name: string, fetcher: (workspaceId: string) => Promise<T>) {
  const { workspace } = useApp();
  return useQuery({ queryKey: [name, workspace.id], queryFn: () => fetcher(workspace.id) });
}

export const useGuests = () => useWorkspaceQuery('guests', api.listGuests);
export const usePeriods = () => useWorkspaceQuery('periods', api.listPeriods);
export const useCandidates = () => useWorkspaceQuery('candidates', api.listCandidates);
export const useHolds = () => useWorkspaceQuery('holds', api.listHolds);
export const useBlocking = () => useWorkspaceQuery('blocking', api.listBlocking);
export const useBookings = () => useWorkspaceQuery('bookings', api.listBookings);
export const usePayments = () => useWorkspaceQuery('payments', api.listPayments);

export const useInstallments = (bookingId: string | undefined) =>
  useQuery({ queryKey: ['installments', bookingId], queryFn: () => api.listInstallments(bookingId!), enabled: Boolean(bookingId) });

type EventKind = 'hold' | 'payment' | 'booking';
const eventFetchers: Record<EventKind, (id: string) => ReturnType<typeof api.listHoldEvents>> = {
  hold: api.listHoldEvents,
  payment: api.listPaymentEvents,
  booking: api.listBookingEvents,
};
export const useEvents = (kind: EventKind, id: string | undefined) =>
  useQuery({ queryKey: ['events', kind, id], queryFn: () => eventFetchers[kind](id!), enabled: Boolean(id) });

// --- Mutations -----------------------------------------------------------------
/**
 * Wraps a server action. While it runs `pending` is true (buttons disable themselves, so a
 * double tap cannot submit twice). Nothing is shown as done until the server has answered:
 * on success every query is refetched, on failure the error is kept for display. Conflict
 * errors also trigger a refetch, because they mean what is on screen is out of date.
 */
export function useAction<TArgs, TResult = unknown>(action: (args: TArgs) => Promise<TResult>, onDone?: (result: TResult, args: TArgs) => void) {
  const mutation = useMutation<TResult, AppError, TArgs>({
    mutationFn: async (args) => {
      try {
        return await action(args);
      } catch (error) {
        throw toAppError(error);
      }
    },
    onSuccess: async (result, args) => {
      await refreshEverything();
      onDone?.(result, args);
    },
    onError: (error) => {
      if (/^(DATES_|HOLD_|CANDIDATE_|PAYMENT_VOIDED|INVALID_STATUS)/.test(error.code)) void refreshEverything();
    },
  });
  return {
    run: (args: TArgs) => {
      if (!mutation.isPending) mutation.mutate(args);
    },
    pending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}

// --- Small UI helpers ------------------------------------------------------------
export function useLocale(): AppLocale {
  const { i18n } = useTranslation();
  return toLocale(i18n.language);
}

/** Re-renders the caller on an interval, for countdowns. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Turns an error into a sentence in the current language. */
export function useErrorText() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { timeZone } = useApp();
  return (error: unknown): string => {
    const e = toAppError(error);
    const d = e.detail;
    const params: Record<string, string> = {
      guest: typeof d.guest_name === 'string' ? d.guest_name : '—',
      start: typeof d.start_date === 'string' ? formatDate(d.start_date, locale) : '',
      end: typeof d.end_date === 'string' ? formatDate(d.end_date, locale) : '',
    };
    const instant = d.expires_at ?? d.cutoff;
    if (typeof instant === 'string') {
      const deadline = describeDeadline(instant, locale, timeZone);
      params.deadline = t(`holds.deadline.${deadline.kind}`, deadline);
    }
    return t(`errors.${e.code}`, params);
  };
}

/** Same as useErrorText but usable outside AppProvider (login screen). */
export function useBasicErrorText() {
  const { t } = useTranslation();
  return (error: unknown): string => t(`errors.${toAppError(error).code}`, { guest: '—', start: '', end: '', deadline: '' });
}

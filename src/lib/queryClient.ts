import { QueryClient } from '@tanstack/react-query';
import { AppError } from '../utils/errors';

// One place decides how fresh data is kept:
//  - refetch when the tab/app comes back to the foreground or the network returns,
//  - poll once a minute so family members see each other's changes,
//  - every successful mutation invalidates everything (see hooks/useAction).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => error instanceof AppError && error.code === 'NETWORK' && failureCount < 2,
    },
    mutations: { retry: false },
  },
});

export const refreshEverything = () => queryClient.invalidateQueries();

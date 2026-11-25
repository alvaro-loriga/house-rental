import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../features/auth/AuthContext';
import { applyLocale, storedLocale } from '../lib/i18n';
import * as api from '../services/api';
import type { MemberRole, Property, Workspace } from '../types/database';
import type { AppLocale } from '../utils/format';

const PROPERTY_KEY = 'rental.property';
const WORKSPACE_KEY = 'rental.workspace';

interface AppValue {
  userId: string;
  workspace: Workspace;
  workspaces: Workspace[];
  setWorkspaceId: (id: string) => void;
  role: MemberRole;
  isAdmin: boolean;
  /** Active (non-archived) properties of the workspace. */
  properties: Property[];
  allProperties: Property[];
  /** 'all' or a property id. */
  propertyFilter: string;
  setPropertyFilter: (value: string) => void;
  /** The selected property, or the only one when there is just one. */
  selectedProperty: Property | null;
  inScope: (propertyId: string) => boolean;
  timeZone: string;
  setLocale: (locale: AppLocale) => void;
}

const AppContext = createContext<AppValue | null>(null);

type Gate = { state: 'loading' } | { state: 'error'; error: unknown; retry: () => void } | { state: 'no-access' } | { state: 'ready' };

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

/**
 * Loads what every screen needs: the caller's workspaces (after accepting any pending
 * invitation), their role and the properties. Renders `fallback` until that is known.
 */
export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (gate: Gate) => ReactNode }) {
  const { user } = useAuth();
  const userId = user!.id;
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(() => read(WORKSPACE_KEY));
  const [propertyFilter, setPropertyFilterState] = useState<string>(() => read(PROPERTY_KEY) ?? 'all');

  const access = useQuery({
    queryKey: ['access', userId],
    queryFn: async () => {
      await api.acceptInvitations();
      const [workspaces, memberships] = await Promise.all([api.listWorkspaces(), api.listMyMemberships(userId)]);
      return { workspaces, memberships };
    },
    refetchInterval: false,
  });

  // The preference saved in the account wins over the device once, right after sign-in.
  useEffect(() => {
    let cancelled = false;
    api
      .getPreferredLocale(userId)
      .then((locale) => {
        if (!cancelled && locale && locale !== storedLocale()) void applyLocale(locale);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const workspaces = access.data?.workspaces ?? [];
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null;

  const propertiesQuery = useQuery({
    queryKey: ['properties', workspace?.id],
    queryFn: () => api.listProperties(workspace!.id),
    enabled: Boolean(workspace),
  });

  const setLocale = useCallback(
    (locale: AppLocale) => {
      void applyLocale(locale);
      api.savePreferredLocale(userId, locale).catch(() => undefined);
    },
    [userId],
  );

  const value = useMemo<AppValue | null>(() => {
    if (!workspace || !propertiesQuery.data) return null;
    const allProperties = propertiesQuery.data;
    const properties = allProperties.filter((p) => !p.archived_at);
    const role = access.data?.memberships.find((m) => m.workspace_id === workspace.id)?.role ?? 'member';
    const filter = properties.some((p) => p.id === propertyFilter) ? propertyFilter : 'all';
    const selectedProperty = properties.find((p) => p.id === filter) ?? (properties.length === 1 ? properties[0] : null);
    return {
      userId,
      workspace,
      workspaces,
      setWorkspaceId: (id) => {
        write(WORKSPACE_KEY, id);
        setWorkspaceIdState(id);
      },
      role,
      isAdmin: role === 'admin',
      properties,
      allProperties,
      propertyFilter: filter,
      setPropertyFilter: (next) => {
        write(PROPERTY_KEY, next);
        setPropertyFilterState(next);
      },
      selectedProperty,
      inScope: (propertyId) => filter === 'all' || propertyId === filter,
      timeZone: selectedProperty?.timezone ?? properties[0]?.timezone ?? 'Europe/Madrid',
      setLocale,
    };
  }, [workspace, workspaces, propertiesQuery.data, access.data, propertyFilter, userId, setLocale]);

  if (access.isError) return <>{fallback({ state: 'error', error: access.error, retry: () => void access.refetch() })}</>;
  if (propertiesQuery.isError) {
    return <>{fallback({ state: 'error', error: propertiesQuery.error, retry: () => void propertiesQuery.refetch() })}</>;
  }
  if (access.isPending) return <>{fallback({ state: 'loading' })}</>;
  if (!workspace) return <>{fallback({ state: 'no-access' })}</>;
  if (!value) return <>{fallback({ state: 'loading' })}</>;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}

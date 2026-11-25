import type { Session, User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { queryClient } from '../../lib/queryClient';
import { supabase } from '../../lib/supabase';
import { toAppError } from '../../utils/errors';

interface AuthValue {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (password: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user: session?.user ?? null,
      loading,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw toAppError(error);
      },
      async signOut() {
        // Drop every cached row before the session goes, so nothing private stays in memory.
        queryClient.clear();
        const { error } = await supabase.auth.signOut();
        if (error) throw toAppError(error);
      },
      async changePassword(password) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw toAppError(error);
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

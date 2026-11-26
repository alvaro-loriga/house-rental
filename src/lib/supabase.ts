import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False when the two public environment variables are missing; the app then shows setup help. */
export const isConfigured = Boolean(url && key);

// Only the public (anon / publishable) key ever reaches the browser. Everything it can do is
// limited by row level security and by the RPC grants in supabase/migrations.
export const supabase = createClient(url || 'http://localhost:44321', key || 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

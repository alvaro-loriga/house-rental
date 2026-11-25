// Quick check that the local backend answers the way the app's data layer expects.
// Usage: start `npm run backend:local` in one terminal, then `node scripts/smoke-local.mjs`.
import { createClient } from '@supabase/supabase-js';

const url = `http://localhost:${process.env.LOCAL_API_PORT ?? 54321}`;
const password = process.env.LOCAL_DEV_PASSWORD ?? 'rental-demo';
const client = () => createClient(url, 'local-anon-key', { auth: { persistSession: false, autoRefreshToken: false } });
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${extra}`);
  if (!ok) process.exitCode = 1;
};

const anon = client();
const anonRead = await anon.from('guests').select('*');
check('anon cannot read guests', Boolean(anonRead.error), anonRead.error?.code ?? '');

const admin = client();
const login = await admin.auth.signInWithPassword({ email: 'admin@example.test', password });
check('admin signs in', !login.error, login.error?.message ?? '');
const bad = await client().auth.signInWithPassword({ email: 'admin@example.test', password: 'wrong-password' });
check('wrong password is rejected', Boolean(bad.error));

const accepted = await admin.rpc('accept_invitations');
check('rpc scalar result', accepted.data === 0, JSON.stringify(accepted));
const workspaces = await admin.from('workspaces').select('*').order('name');
check('admin sees one workspace', workspaces.data?.length === 1);
const ws = workspaces.data[0].id;
const members = await admin.rpc('list_members', { p_workspace_id: ws });
check('rpc set result', members.data?.length === 2, JSON.stringify(members.error ?? ''));
const bookings = await admin.from('v_bookings').select('*').eq('workspace_id', ws).order('start_date', { ascending: true });
check('bookings view', bookings.data?.length === 5, String(bookings.data?.length));
const next = bookings.data.find((b) => b.guest_name === 'Ana Ejemplo');
check('EUR 700 - EUR 200 = EUR 500 outstanding', next?.total_price === 700 && next?.net_paid === 200 && next?.outstanding === 500, JSON.stringify(next && [next.total_price, next.net_paid, next.outstanding]));
const holds = await admin.from('v_holds').select('*').eq('workspace_id', ws);
check('one effective and one expired hold', holds.data?.filter((h) => h.is_effective).length === 1 && holds.data?.filter((h) => h.effective_status === 'expired').length === 1);
const invitations = await admin.from('workspace_invitations').select('*').eq('workspace_id', ws).is('accepted_at', null).is('revoked_at', null);
check('is.null filters', Array.isArray(invitations.data), JSON.stringify(invitations.error ?? ''));

const guest = await admin.from('guests').insert({ workspace_id: ws, full_name: 'Smoke Test', phone: null }).select('id').single();
check('insert ... select single', Boolean(guest.data?.id), JSON.stringify(guest.error ?? ''));
const updated = await admin.from('guests').update({ notes: 'updated' }).eq('id', guest.data.id);
check('update', !updated.error, JSON.stringify(updated.error ?? ''));
const pref = await admin.from('user_preferences').upsert({ user_id: login.data.user.id, locale: 'en-GB' }, { onConflict: 'user_id' });
const pref2 = await admin.from('user_preferences').upsert({ user_id: login.data.user.id, locale: 'es-ES' }, { onConflict: 'user_id' });
check('upsert twice', !pref.error && !pref2.error, JSON.stringify(pref.error ?? pref2.error ?? ''));

const clash = await admin.rpc('create_booking', {
  p_property_id: next.property_id, p_guest_id: guest.data.id, p_start_date: next.start_date, p_end_date: next.end_date, p_total_price: 1,
});
check('conflict error code and detail reach the client', clash.error?.message === 'DATES_BOOKED' && JSON.parse(clash.error.details).guest_name === 'Ana Ejemplo', JSON.stringify(clash.error));
const schedule = await admin.rpc('set_installments', { p_booking_id: next.id, p_items: [{ due_date: next.start_date, amount: 500, description: 'Resto' }] });
check('jsonb argument', schedule.data === 1, JSON.stringify(schedule.error ?? ''));
const directWrite = await admin.from('payments').insert({ workspace_id: ws, booking_id: next.id, amount: 1, payment_date: '2027-01-01', payment_method: 'cash', payment_type: 'other' });
check('direct payment insert is refused', directWrite.error?.code === '42501', directWrite.error?.code ?? '');

const outsider = client();
await outsider.auth.signInWithPassword({ email: 'outsider@example.test', password });
const none = await outsider.from('v_bookings').select('*');
check('outsider sees no bookings', none.data?.length === 0);
const denied = await outsider.rpc('list_members', { p_workspace_id: ws });
check('outsider cannot call member RPC', denied.error?.message === 'NOT_A_MEMBER');

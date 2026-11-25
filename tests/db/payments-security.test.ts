import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addCandidate, addPeriod, admin, as, closeAll, createWorld, outcome, rpc, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(closeAll);

const booking = (user: string, guest: string, start: string, end: string, total: number, extra: Record<string, unknown> = {}) =>
  rpc<string>(user, 'create_booking', {
    p_property_id: w.propA, p_guest_id: guest, p_start_date: start, p_end_date: end, p_total_price: total, ...extra,
  });
const balance = async (user: string, id: string) =>
  (await (await as(user)).query(`select * from public.v_bookings where id = $1`, [id])).rows[0];
const pay = (user: string, id: string, amount: number, type = 'partial_payment', date = '2027-06-01') =>
  rpc<string>(user, 'record_payment', {
    p_booking_id: id, p_amount: amount, p_payment_date: date, p_payment_method: 'bank_transfer', p_payment_type: type,
  });

describe('payments', () => {
  it('10. EUR 700 booking + EUR 200 receipt = EUR 500 outstanding; refunds and voids adjust and are audited', async () => {
    const id = await booking(w.alice, w.guests.ana, '2027-08-01', '2027-08-08', 700);
    expect(await balance(w.alice, id)).toMatchObject({ net_paid: 0, outstanding: 700, payment_status: 'unpaid', nights: 7 });

    const deposit = await pay(w.alice, id, 200, 'deposit');
    expect(await balance(w.bob, id)).toMatchObject({
      gross_receipts: 200, refunds: 0, net_paid: 200, outstanding: 500, payment_status: 'partially_paid', paid_percent: 28.6, deposit_paid: 200,
    });

    // Refund is stored positive and subtracted.
    expect(await outcome(pay(w.alice, id, 250, 'refund'))).toBe('REFUND_EXCEEDS_RECEIPTS');
    const refund = await pay(w.alice, id, 50, 'refund');
    expect((await admin.query(`select amount from public.payments where id = $1`, [refund])).rows[0].amount).toBe(50);
    expect(await balance(w.alice, id)).toMatchObject({ gross_receipts: 200, refunds: 50, net_paid: 150, outstanding: 550 });

    // Voiding needs a reason; voiding the receipt that a refund depends on is refused.
    expect(await outcome(rpc(w.alice, 'void_payment', { p_payment_id: refund, p_reason: '' }))).toBe('REASON_REQUIRED');
    expect(await outcome(rpc(w.alice, 'void_payment', { p_payment_id: deposit, p_reason: 'wrong booking' }))).toBe('REFUND_EXCEEDS_RECEIPTS');
    await rpc(w.bob, 'void_payment', { p_payment_id: refund, p_reason: 'refund was never sent' });
    expect(await balance(w.alice, id)).toMatchObject({ refunds: 0, net_paid: 200, outstanding: 500 });
    expect(await outcome(rpc(w.bob, 'void_payment', { p_payment_id: refund, p_reason: 'again' }))).toBe('PAYMENT_VOIDED');

    // Correction keeps old and new values.
    await rpc(w.alice, 'correct_payment', {
      p_payment_id: deposit, p_amount: 250, p_payment_date: '2027-06-02', p_payment_method: 'bizum', p_payment_type: 'deposit',
      p_notes: null, p_reason: 'typo in amount',
    });
    expect(await balance(w.alice, id)).toMatchObject({ net_paid: 250, outstanding: 450 });
    const events = await admin.query(
      `select e.event_type, e.actor_id, e.reason, e.previous_values, e.new_values
         from public.payment_events e where e.payment_id = any($1) order by e.event_at, e.event_type`,
      [[deposit, refund]],
    );
    expect(events.rows.map((r) => r.event_type).sort()).toEqual(['corrected', 'created', 'created', 'voided']);
    const corrected = events.rows.find((r) => r.event_type === 'corrected');
    expect(corrected).toMatchObject({ actor_id: w.alice, reason: 'typo in amount' });
    expect(corrected.previous_values.amount).toBe(200);
    expect(corrected.new_values.amount).toBe(250);
    expect(events.rows.find((r) => r.event_type === 'voided')).toMatchObject({ actor_id: w.bob, reason: 'refund was never sent' });

    // Payments exist forever: clients cannot delete or edit them directly.
    const client = await as(w.alice);
    expect(await outcome(client.query(`delete from public.payments where id = $1`, [deposit]))).toMatch(/permission denied/);
    expect(await outcome(client.query(`update public.payments set amount = 1 where id = $1`, [deposit]))).toMatch(/permission denied/);
    expect(await outcome(client.query(`delete from public.payment_events`))).toMatch(/permission denied/);
  });

  it('10. shows overpayments as a credit and handles zero-price bookings', async () => {
    const id = await booking(w.alice, w.guests.carlos, '2027-08-08', '2027-08-15', 300);
    await pay(w.alice, id, 350);
    expect(await balance(w.alice, id)).toMatchObject({ net_paid: 350, outstanding: -50, payment_status: 'overpaid' });
    const free = await booking(w.alice, w.guests.pedro, '2027-08-15', '2027-08-16', 0);
    expect(await balance(w.alice, free)).toMatchObject({ outstanding: 0, payment_status: 'paid', paid_percent: null });
    expect(await outcome(pay(w.alice, id, 0))).toBe('INVALID_AMOUNT');
    expect(await outcome(pay(w.alice, id, 10.001))).toBe('INVALID_AMOUNT');
  });

  it('11. ten monthly instalments of EUR 550 total EUR 5,500 and only past ones can be overdue', async () => {
    // A winter rental that is already under way: 1 Sep (two months ago) to 1 Jul next year.
    const today = (await admin.query(`select (now() at time zone 'Europe/Madrid')::date as d`)).rows[0].d as string;
    const firstOfMonth = (offset: number) =>
      admin
        .query(`select (date_trunc('month', $1::date) + make_interval(months => $2))::date as d`, [today, offset])
        .then((r) => r.rows[0].d as string);
    const start = await firstOfMonth(-2);
    const end = await firstOfMonth(8);
    const id = await booking(w.alice, w.guests.juan, start, end, 5500, { p_pricing_type: 'per_month', p_unit_price: 550 });
    const items = [];
    for (let i = 0; i < 10; i++) items.push({ due_date: await firstOfMonth(i - 2), amount: 550, description: `Month ${i + 1}` });
    expect(await rpc(w.alice, 'set_installments', { p_booking_id: id, p_items: JSON.stringify(items) })).toBe(10);

    const dueSoFar = items.filter((i) => i.due_date <= today).length; // 3 (or 3 on the 1st)
    const pastDue = items.filter((i) => i.due_date < today).length;
    let b = await balance(w.alice, id);
    expect(b).toMatchObject({ scheduled_total: 5500, due_to_date: dueSoFar * 550, overdue: pastDue * 550, outstanding: 5500 });

    // One full month and one partial payment: the oldest instalments are covered first.
    await pay(w.alice, id, 550, 'partial_payment', start);
    await pay(w.alice, id, 200, 'partial_payment', today);
    b = await balance(w.alice, id);
    expect(b).toMatchObject({ net_paid: 750, outstanding: 4750, overdue: Math.max(0, pastDue * 550 - 750) });
    expect(b.overdue).toBeLessThan(b.outstanding); // future instalments are not overdue

    // Regenerating the schedule replaces it instead of duplicating it.
    expect(await rpc(w.alice, 'set_installments', { p_booking_id: id, p_items: JSON.stringify(items) })).toBe(10);
    expect((await admin.query(`select count(*)::int n, sum(amount) s from public.payment_installments where booking_id = $1`, [id])).rows[0]).toEqual({ n: 10, s: 5500 });

    // A schedule entirely in the future is never overdue.
    const future = await booking(w.alice, w.guests.pedro, '2035-09-01', '2036-07-01', 5500, { p_pricing_type: 'per_month', p_unit_price: 550 });
    const futureItems = Array.from({ length: 10 }, (_, i) => ({
      due_date: i < 4 ? `2035-${String(9 + i).padStart(2, '0')}-01` : `2036-${String(i - 3).padStart(2, '0')}-01`,
      amount: 550,
    }));
    await rpc(w.alice, 'set_installments', { p_booking_id: future, p_items: JSON.stringify(futureItems) });
    expect(await balance(w.alice, future)).toMatchObject({ scheduled_total: 5500, due_to_date: 0, overdue: 0, outstanding: 5500, nights: 304 });
  });

  it('12. cancelling releases the dates but keeps payments; completed stays keep blocking history', async () => {
    const id = await booking(w.alice, w.guests.maria, '2027-12-01', '2027-12-08', 700);
    await pay(w.alice, id, 200, 'deposit');
    expect(await outcome(rpc(w.alice, 'set_booking_status', { p_booking_id: id, p_status: 'cancelled' }))).toBe('REASON_REQUIRED');
    await rpc(w.alice, 'set_booking_status', { p_booking_id: id, p_status: 'cancelled', p_reason: 'Guest cancelled', p_cancellation_fee: 100 });

    // Dates are free again for someone else.
    const next = await booking(w.bob, w.guests.pedro, '2027-12-01', '2027-12-08', 650);
    // History and money are still there; nothing is outstanding on the cancelled booking.
    expect(await balance(w.alice, id)).toMatchObject({ status: 'cancelled', net_paid: 200, outstanding: 0, cancellation_fee: 100, cancellation_reason: 'Guest cancelled' });
    // The refund of the non-retained part is a separate, auditable payment.
    await pay(w.alice, id, 100, 'refund');
    expect(await balance(w.alice, id)).toMatchObject({ gross_receipts: 200, refunds: 100, net_paid: 100 });
    expect((await admin.query(`select count(*)::int n from public.payments where booking_id = $1`, [id])).rows[0].n).toBe(2);
    expect(await outcome(rpc(w.alice, 'set_booking_status', { p_booking_id: id, p_status: 'confirmed' }))).toBe('INVALID_STATUS_TRANSITION');
    const log = await admin.query(`select event_type from public.booking_events where booking_id = $1 order by event_at`, [id]);
    expect(log.rows.map((r) => r.event_type)).toEqual(['confirmed', 'cancelled']);

    // Completing keeps the stay in the books and still blocks its (historical) nights.
    await rpc(w.bob, 'set_booking_status', { p_booking_id: next, p_status: 'completed' });
    expect(await balance(w.bob, next)).toMatchObject({ status: 'completed', total_price: 650 });
    expect(await outcome(booking(w.alice, w.guests.juan, '2027-12-03', '2027-12-05', 1))).toBe('DATES_BOOKED');
  });

  it('12. cancelling a booking made from a prospect reopens the period', async () => {
    const period = await addPeriod(w.alice, w, w.propA2, '2028-10-01', '2028-10-08');
    const cand = await addCandidate(w.alice, w, period, w.guests.ana);
    const id = await rpc<string>(w.alice, 'confirm_candidate', { p_candidate_id: cand, p_total_price: 400 });
    await rpc(w.alice, 'set_booking_status', { p_booking_id: id, p_status: 'cancelled', p_reason: 'changed plans' });
    expect((await admin.query(`select status from public.booking_periods where id = $1`, [period])).rows[0].status).toBe('open');
    expect((await admin.query(`select status from public.booking_candidates where id = $1`, [cand])).rows[0].status).toBe('discarded');
  });
});

describe('13. access control', () => {
  const tables = [
    'workspaces', 'workspace_members', 'workspace_invitations', 'user_preferences', 'properties', 'guests', 'booking_periods',
    'booking_candidates', 'bookings', 'booking_events', 'temporary_holds', 'hold_events', 'availability_allocations',
    'payment_installments', 'payments', 'payment_events', 'v_bookings', 'v_holds', 'v_blocking', 'v_candidates', 'v_payments', 'v_guests',
  ];

  it('row level security is enabled on every application table', async () => {
    const res = await admin.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(res.rows).toEqual([]);
  });

  it('unauthenticated requests can read nothing and call nothing', async () => {
    const anon = await as(null);
    for (const t of tables) {
      expect(await outcome(anon.query(`select * from public.${t} limit 1`)), t).toMatch(/permission denied/);
    }
    expect(await outcome(rpc(null, 'accept_invitations'))).toMatch(/permission denied/);
    expect(await outcome(rpc(null, 'list_members', { p_workspace_id: w.wsA }))).toMatch(/permission denied/);
    expect(
      await outcome(rpc(null, 'create_booking', { p_property_id: w.propA, p_guest_id: w.guests.ana, p_start_date: '2040-01-01', p_end_date: '2040-01-02', p_total_price: 1 })),
    ).toMatch(/permission denied/);
  });

  it('a signed-in user without membership sees no rows and cannot use the RPCs', async () => {
    const id = await booking(w.alice, w.guests.ana, '2029-05-01', '2029-05-08', 700);
    const payment = await pay(w.alice, id, 100);
    const mallory = await as(w.mallory);
    for (const t of tables) {
      expect((await mallory.query(`select * from public.${t}`)).rows, t).toHaveLength(0);
    }
    const m = (fn: string, args: Record<string, unknown>) => outcome(rpc(w.mallory, fn, args));
    expect(await m('create_booking', { p_property_id: w.propA, p_guest_id: w.guests.ana, p_start_date: '2040-01-01', p_end_date: '2040-01-02', p_total_price: 1 })).toBe('NOT_A_MEMBER');
    expect(await m('record_payment', { p_booking_id: id, p_amount: 1, p_payment_date: '2027-01-01', p_payment_method: 'cash', p_payment_type: 'other' })).toBe('NOT_A_MEMBER');
    expect(await m('void_payment', { p_payment_id: payment, p_reason: 'x' })).toBe('NOT_A_MEMBER');
    expect(await m('set_booking_status', { p_booking_id: id, p_status: 'cancelled', p_reason: 'x' })).toBe('NOT_A_MEMBER');
    expect(await m('list_members', { p_workspace_id: w.wsA })).toBe('NOT_A_MEMBER');
    expect(await m('invite_member', { p_workspace_id: w.wsA, p_email: 'evil@example.test' })).toBe('ADMIN_REQUIRED');
    // Direct writes are stopped by RLS even where the table grant exists.
    expect(await outcome(mallory.query(`insert into public.guests (workspace_id, full_name) values ($1, 'x')`, [w.wsA]))).toMatch(/row-level security/);
    expect(await outcome(mallory.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'admin')`, [w.wsA, w.mallory]))).toMatch(/permission denied/);
    expect((await mallory.query(`update public.guests set full_name = 'hacked' where workspace_id = $1 returning id`, [w.wsA])).rows).toHaveLength(0);
  });

  it('members of another workspace are isolated too', async () => {
    const carol = await as(w.carol);
    expect((await carol.query(`select id from public.properties`)).rows.map((r) => r.id)).toEqual([w.propB]);
    expect((await carol.query(`select * from public.v_bookings`)).rows).toHaveLength(0);
  });

  it('members collaborate; only admins manage membership; access is invitation-based', async () => {
    // Bob (member) sees and changes what Alice created.
    const id = await booking(w.alice, w.guests.carlos, '2029-06-01', '2029-06-08', 500);
    expect(await outcome(pay(w.bob, id, 100))).toBe('OK');
    expect((await balance(w.alice, id)).net_paid).toBe(100);

    expect(await outcome(rpc(w.bob, 'invite_member', { p_workspace_id: w.wsA, p_email: 'x@example.test' }))).toBe('ADMIN_REQUIRED');
    expect(await outcome(rpc(w.bob, 'remove_member', { p_workspace_id: w.wsA, p_user_id: w.alice }))).toBe('ADMIN_REQUIRED');
    expect(await outcome((await as(w.bob)).query(`insert into public.properties (workspace_id, name) values ($1,'x')`, [w.wsA]))).toMatch(/row-level security/);

    // Mallory gains access only once an admin invites her e-mail address.
    expect(await rpc(w.mallory, 'accept_invitations')).toBe(0);
    const email = (await admin.query(`select email from auth.users where id = $1`, [w.mallory])).rows[0].email as string;
    await rpc(w.alice, 'invite_member', { p_workspace_id: w.wsA, p_email: email.toUpperCase() });
    expect(await rpc(w.mallory, 'accept_invitations')).toBe(1);
    expect((await (await as(w.mallory)).query(`select id from public.properties order by name`)).rows).toHaveLength(2);
    const members = await rpc(w.alice, 'list_members', { p_workspace_id: w.wsA });
    expect(members).toBeTruthy();

    // An unconfirmed e-mail address must not accept invitations.
    const pending = (await admin.query(`insert into auth.users (email, email_confirmed_at) values ($1, null) returning id`, [`pending-${Date.now()}@example.test`])).rows[0].id;
    await admin.query(`insert into public.workspace_invitations (workspace_id, email) select $1, email from auth.users where id = $2`, [w.wsA, pending]);
    expect(await rpc(pending, 'accept_invitations')).toBe(0);

    // The last admin cannot be removed or demoted.
    expect(await outcome(rpc(w.alice, 'remove_member', { p_workspace_id: w.wsA, p_user_id: w.alice }))).toBe('LAST_ADMIN');
    expect(await outcome(rpc(w.alice, 'set_member_role', { p_workspace_id: w.wsA, p_user_id: w.alice, p_role: 'member' }))).toBe('LAST_ADMIN');
    await rpc(w.alice, 'remove_member', { p_workspace_id: w.wsA, p_user_id: w.mallory });
    expect((await (await as(w.mallory)).query(`select id from public.properties`)).rows).toHaveLength(0);
  });

  it('users can only read and write their own preferences', async () => {
    const alice = await as(w.alice);
    await alice.query(`insert into public.user_preferences (user_id, locale) values ($1, 'en-GB')`, [w.alice]);
    expect((await (await as(w.bob)).query(`select * from public.user_preferences`)).rows).toHaveLength(0);
    expect(await outcome((await as(w.bob)).query(`insert into public.user_preferences (user_id, locale) values ($1, 'en-GB')`, [w.alice]))).toMatch(/row-level security/);
    expect(await outcome(alice.query(`update public.user_preferences set locale = 'fr-FR' where user_id = $1`, [w.alice]))).toMatch(/check constraint/);
  });
});

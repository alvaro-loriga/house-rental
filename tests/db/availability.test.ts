import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCandidate,
  addPeriod,
  admin,
  as,
  closeAll,
  createWorld,
  dbNowPlus,
  outcome,
  rpc,
  rpcOn,
  session,
  sleep,
  type World,
} from './helpers';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(closeAll);

const activeBookingsOn = async (propertyId: string, start: string, end: string) =>
  (
    await admin.query(
      `select count(*)::int as n from public.availability_allocations
        where property_id = $1 and active and kind = 'booking' and stay && daterange($2::date, $3::date, '[)')`,
      [propertyId, start, end],
    )
  ).rows[0].n as number;

describe('candidates and confirmation', () => {
  it('1. lets several undecided candidates coexist on identical and overlapping dates', async () => {
    const p1 = await addPeriod(w.alice, w, w.propA, '2027-08-01', '2027-08-08');
    const p2 = await addPeriod(w.bob, w, w.propA, '2027-08-05', '2027-08-12'); // overlaps p1
    await addCandidate(w.alice, w, p1, w.guests.ana, 'undecided', 700);
    await addCandidate(w.bob, w, p1, w.guests.carlos, 'interested', 650);
    await addCandidate(w.bob, w, p2, w.guests.pedro, 'undecided', 650);
    const rows = await admin.query(
      `select count(*)::int as n from public.booking_candidates where booking_period_id = any($1)`,
      [[p1, p2]],
    );
    expect(rows.rows[0].n).toBe(3);
    expect(await activeBookingsOn(w.propA, '2027-08-01', '2027-08-12')).toBe(0);
    const blocking = await (await as(w.alice)).query(`select * from public.v_blocking where property_id = $1`, [w.propA]);
    expect(blocking.rows).toHaveLength(0);
  });

  it('2. confirming a candidate creates exactly one booking and updates the candidate atomically', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2027-09-01', '2027-09-08');
    const ana = await addCandidate(w.alice, w, period, w.guests.ana, 'undecided', 700);
    const carlos = await addCandidate(w.alice, w, period, w.guests.carlos, 'interested', 650);

    const bookingId = await rpc<string>(w.alice, 'confirm_candidate', {
      p_candidate_id: ana,
      p_total_price: 700,
      p_discard_others: true,
    });
    const bookings = await admin.query(`select * from public.bookings where booking_period_id = $1`, [period]);
    expect(bookings.rows).toHaveLength(1);
    expect(bookings.rows[0]).toMatchObject({ id: bookingId, status: 'confirmed', total_price: 700, guest_id: w.guests.ana });
    const cands = await admin.query(`select id, status from public.booking_candidates where booking_period_id = $1`, [period]);
    expect(Object.fromEntries(cands.rows.map((r) => [r.id, r.status]))).toEqual({ [ana]: 'confirmed', [carlos]: 'discarded' });
    expect((await admin.query(`select status from public.booking_periods where id = $1`, [period])).rows[0].status).toBe('booked');
    expect(await activeBookingsOn(w.propA, '2027-09-01', '2027-09-08')).toBe(1);

    // Confirming again (or confirming the discarded one) is refused and creates nothing.
    expect(await outcome(rpc(w.alice, 'confirm_candidate', { p_candidate_id: ana, p_total_price: 700 }))).toBe('CANDIDATE_NOT_ELIGIBLE');
    expect(await outcome(rpc(w.alice, 'confirm_candidate', { p_candidate_id: carlos, p_total_price: 650 }))).toBe('CANDIDATE_NOT_ELIGIBLE');
    expect((await admin.query(`select count(*)::int n from public.bookings where booking_period_id = $1`, [period])).rows[0].n).toBe(1);
  });

  it('keeps the other candidates when the user chooses not to discard them', async () => {
    const period = await addPeriod(w.alice, w, w.propA2, '2027-09-01', '2027-09-08');
    const ana = await addCandidate(w.alice, w, period, w.guests.ana, 'undecided', 700);
    const carlos = await addCandidate(w.alice, w, period, w.guests.carlos, 'interested', 650);
    await rpc(w.alice, 'confirm_candidate', { p_candidate_id: ana, p_total_price: 700 });
    expect((await admin.query(`select status from public.booking_candidates where id = $1`, [carlos])).rows[0].status).toBe('interested');
  });

  it('refuses a direct client write that sets a candidate to confirmed', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2029-01-01', '2029-01-08');
    const cand = await addCandidate(w.alice, w, period, w.guests.ana);
    const client = await as(w.alice);
    expect(await outcome(client.query(`update public.booking_candidates set status = 'confirmed' where id = $1`, [cand]))).toBe(
      'DIRECT_WRITE_FORBIDDEN',
    );
    expect(await outcome(client.query(`update public.booking_candidates set status = 'discarded' where id = $1`, [cand]))).toBe('OK');
  });
});

describe('booking conflicts', () => {
  it('3. rejects an overlapping confirmed booking and allows a provisional one', async () => {
    const base = { p_property_id: w.propA, p_total_price: 500 };
    await rpc(w.alice, 'create_booking', { ...base, p_guest_id: w.guests.juan, p_start_date: '2027-10-01', p_end_date: '2027-10-08' });
    expect(
      await outcome(rpc(w.bob, 'create_booking', { ...base, p_guest_id: w.guests.pedro, p_start_date: '2027-10-05', p_end_date: '2027-10-12' })),
    ).toBe('DATES_BOOKED');
    const provisional = await rpc<string>(w.bob, 'create_booking', {
      ...base,
      p_guest_id: w.guests.pedro,
      p_start_date: '2027-10-05',
      p_end_date: '2027-10-12',
      p_status: 'provisional',
    });
    expect(await outcome(rpc(w.bob, 'set_booking_status', { p_booking_id: provisional, p_status: 'confirmed' }))).toBe('DATES_BOOKED');
  });

  it('3. lets only one of two simultaneous requests from different sessions win', async () => {
    for (let round = 0; round < 5; round++) {
      const start = `2030-0${round + 1}-10`;
      const end = `2030-0${round + 1}-17`;
      const s1 = await session(w.alice);
      const s2 = await session(w.bob);
      const args = { p_property_id: w.propA, p_start_date: start, p_end_date: end, p_total_price: 100 };
      const results = await Promise.all([
        outcome(rpcOn(s1, 'create_booking', { ...args, p_guest_id: w.guests.ana })),
        outcome(rpcOn(s2, 'create_booking', { ...args, p_guest_id: w.guests.carlos })),
      ]);
      await s1.end();
      await s2.end();
      expect(results.sort()).toEqual(['DATES_BOOKED', 'OK']);
      expect(await activeBookingsOn(w.propA, start, end)).toBe(1);
    }
  });

  it('3. the exclusion constraint itself rejects overlaps even for writes that skip the RPCs', async () => {
    const b = await admin.query(
      `insert into public.bookings (workspace_id, property_id, guest_id, start_date, end_date, total_price, status)
       values ($1,$2,$3,'2031-01-01','2031-01-08',1,'confirmed'), ($1,$2,$3,'2031-01-05','2031-01-12',1,'confirmed') returning id`,
      [w.wsA, w.propA, w.guests.ana],
    );
    const insert = (id: string, range: string) =>
      admin.query(
        `insert into public.availability_allocations (workspace_id, property_id, kind, booking_id, stay) values ($1,$2,'booking',$3,$4::daterange)`,
        [w.wsA, w.propA, id, range],
      );
    await insert(b.rows[0].id, '[2031-01-01,2031-01-08)');
    await expect(insert(b.rows[1].id, '[2031-01-05,2031-01-12)')).rejects.toMatchObject({ code: '23P01' });
  });

  it('4. allows a check-in on the day another booking checks out', async () => {
    const args = { p_property_id: w.propA, p_total_price: 700 };
    await rpc(w.alice, 'create_booking', { ...args, p_guest_id: w.guests.ana, p_start_date: '2027-07-15', p_end_date: '2027-07-22' });
    expect(
      await outcome(rpc(w.alice, 'create_booking', { ...args, p_guest_id: w.guests.carlos, p_start_date: '2027-07-22', p_end_date: '2027-07-29' })),
    ).toBe('OK');
    expect(
      await outcome(rpc(w.alice, 'create_booking', { ...args, p_guest_id: w.guests.pedro, p_start_date: '2027-07-08', p_end_date: '2027-07-15' })),
    ).toBe('OK');
    expect(
      await outcome(rpc(w.alice, 'create_booking', { ...args, p_guest_id: w.guests.pedro, p_start_date: '2027-07-21', p_end_date: '2027-07-23' })),
    ).toBe('DATES_BOOKED');
  });

  it('validates dates and amounts on the server', async () => {
    const args = { p_property_id: w.propA, p_guest_id: w.guests.ana };
    expect(await outcome(rpc(w.alice, 'create_booking', { ...args, p_start_date: '2032-01-08', p_end_date: '2032-01-08', p_total_price: 1 }))).toBe('INVALID_DATES');
    expect(await outcome(rpc(w.alice, 'create_booking', { ...args, p_start_date: '2032-01-01', p_end_date: '2032-01-08', p_total_price: -1 }))).toBe('INVALID_AMOUNT');
    expect(await outcome(rpc(w.alice, 'create_booking', { ...args, p_start_date: '2032-01-01', p_end_date: '2032-01-08', p_total_price: 10.005 }))).toBe('INVALID_AMOUNT');
  });

  it('re-checks conflicts when the dates of a confirmed booking are edited', async () => {
    const mk = (guest: string, s: string, e: string) =>
      rpc<string>(w.alice, 'create_booking', { p_property_id: w.propA2, p_guest_id: guest, p_start_date: s, p_end_date: e, p_total_price: 300 });
    const first = await mk(w.guests.ana, '2028-03-01', '2028-03-08');
    await mk(w.guests.carlos, '2028-03-08', '2028-03-15');
    const edit = (s: string, e: string) =>
      rpc(w.alice, 'update_booking', {
        p_booking_id: first, p_start_date: s, p_end_date: e, p_total_price: 300, p_pricing_type: 'total',
        p_unit_price: null, p_deposit_required: 0, p_notes: null,
      });
    expect(await outcome(edit('2028-03-01', '2028-03-09'))).toBe('DATES_BOOKED');
    expect(await outcome(edit('2028-02-27', '2028-03-08'))).toBe('OK');
    expect(await activeBookingsOn(w.propA2, '2028-02-27', '2028-02-28')).toBe(1);
  });
});

describe('temporary holds', () => {
  it('5. an active hold blocks overlapping bookings and holds, but not enquiries', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2027-11-15', '2027-11-22');
    const maria = await addCandidate(w.alice, w, period, w.guests.maria, 'undecided', 700);
    const holdId = await rpc<string>(w.alice, 'create_hold', { p_candidate_id: maria, p_expires_at: await dbNowPlus(3600) });

    // Enquiries are still welcome, in the same period and in an overlapping one.
    const pedro = await addCandidate(w.bob, w, period, w.guests.pedro, 'interested', 650);
    const other = await addPeriod(w.bob, w, w.propA, '2027-11-20', '2027-11-27');
    const juan = await addCandidate(w.bob, w, other, w.guests.juan, 'interested', 600);

    expect(await outcome(rpc(w.bob, 'create_hold', { p_candidate_id: pedro, p_expires_at: await dbNowPlus(3600) }))).toBe('DATES_HELD');
    expect(await outcome(rpc(w.bob, 'create_hold', { p_candidate_id: juan, p_expires_at: await dbNowPlus(3600) }))).toBe('DATES_HELD');
    expect(await outcome(rpc(w.bob, 'confirm_candidate', { p_candidate_id: pedro, p_total_price: 650 }))).toBe('DATES_HELD');
    expect(
      await outcome(
        rpc(w.bob, 'create_booking', {
          p_property_id: w.propA, p_guest_id: w.guests.juan, p_start_date: '2027-11-21', p_end_date: '2027-11-25', p_total_price: 300,
        }),
      ),
    ).toBe('DATES_HELD');

    const view = await (await as(w.bob)).query(`select * from public.v_blocking where hold_id = $1`, [holdId]);
    expect(view.rows[0]).toMatchObject({ kind: 'hold', guest_name: 'María Ejemplo', start_date: '2027-11-15', end_date: '2027-11-22' });
    await rpc(w.alice, 'release_hold', { p_hold_id: holdId, p_reason: 'test cleanup' });
  });

  it('5. the error tells authorized users who holds the dates and until when', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2028-06-01', '2028-06-08');
    const maria = await addCandidate(w.alice, w, period, w.guests.maria);
    const pedro = await addCandidate(w.alice, w, period, w.guests.pedro);
    await rpc(w.alice, 'create_hold', { p_candidate_id: maria, p_expires_at: await dbNowPlus(3600) });
    try {
      await rpc(w.bob, 'confirm_candidate', { p_candidate_id: pedro, p_total_price: 1 });
      expect.unreachable();
    } catch (error) {
      const detail = JSON.parse((error as { detail: string }).detail);
      expect(detail.guest_name).toBe('María Ejemplo');
      expect(detail.expires_at).toBeTruthy();
    }
  });

  it('rejects a deadline in the past or after check-in (16:00 local, DST aware)', async () => {
    // 28 March 2027 is the day Madrid switches to summer time; 31 October 2027 back to winter time.
    const spring = await addPeriod(w.alice, w, w.propA2, '2027-03-28', '2027-03-30');
    const autumn = await addPeriod(w.alice, w, w.propA2, '2027-10-31', '2027-11-02');
    const c1 = await addCandidate(w.alice, w, spring, w.guests.ana);
    const c2 = await addCandidate(w.alice, w, autumn, w.guests.ana);
    const tryHold = (c: string, at: string) => outcome(rpc(w.alice, 'create_hold', { p_candidate_id: c, p_expires_at: at }));

    expect(await tryHold(c1, '2020-01-01T00:00:00Z')).toBe('HOLD_EXPIRY_IN_PAST');
    // 16:00 CEST = 14:00 UTC on the spring-forward day.
    expect(await tryHold(c1, '2027-03-28T14:00:01Z')).toBe('HOLD_EXPIRY_AFTER_CHECKIN');
    expect(await tryHold(c1, '2027-03-28T14:00:00Z')).toBe('OK');
    // 16:00 CET = 15:00 UTC on the fall-back day.
    expect(await tryHold(c2, '2027-10-31T15:00:01Z')).toBe('HOLD_EXPIRY_AFTER_CHECKIN');
    expect(await tryHold(c2, '2027-10-31T15:00:00Z')).toBe('OK');
  });

  it('6. a hold expires on database time with no session or cleanup job; others can then book', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2028-01-10', '2028-01-17');
    const maria = await addCandidate(w.alice, w, period, w.guests.maria, 'undecided');
    const pedro = await addCandidate(w.alice, w, period, w.guests.pedro, 'interested');
    const holdId = await rpc<string>(w.alice, 'create_hold', { p_candidate_id: maria, p_expires_at: await dbNowPlus(1.5) });
    expect(await outcome(rpc(w.bob, 'confirm_candidate', { p_candidate_id: pedro, p_total_price: 650 }))).toBe('DATES_HELD');

    await sleep(2000); // nothing runs in the meantime

    // Persisted status is still 'active', but every read model already treats it as expired.
    expect((await admin.query(`select status from public.temporary_holds where id = $1`, [holdId])).rows[0].status).toBe('active');
    const bob = await as(w.bob);
    expect((await bob.query(`select effective_status, is_effective from public.v_holds where id = $1`, [holdId])).rows[0]).toEqual({
      effective_status: 'expired',
      is_effective: false,
    });
    expect((await bob.query(`select 1 from public.v_blocking where hold_id = $1`, [holdId])).rows).toHaveLength(0);
    expect(await outcome(rpc(w.alice, 'extend_hold', { p_hold_id: holdId, p_expires_at: await dbNowPlus(3600) }))).toBe('HOLD_EXPIRED');

    expect(await outcome(rpc(w.bob, 'confirm_candidate', { p_candidate_id: pedro, p_total_price: 650 }))).toBe('OK');

    // Expiry did not discard María, and the hold with its history is preserved.
    expect((await admin.query(`select status from public.booking_candidates where id = $1`, [maria])).rows[0].status).toBe('undecided');
    expect((await admin.query(`select status from public.temporary_holds where id = $1`, [holdId])).rows[0].status).toBe('expired');
    const events = await admin.query(`select event_type, actor_id from public.hold_events where hold_id = $1 order by event_at`, [holdId]);
    expect(events.rows).toEqual([
      { event_type: 'created', actor_id: w.alice },
      { event_type: 'expired', actor_id: null },
    ]);
  });

  it('7. a hold can be extended, released and converted, each with a history record', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2028-02-01', '2028-02-08');
    const maria = await addCandidate(w.alice, w, period, w.guests.maria, 'undecided');
    const pedro = await addCandidate(w.alice, w, period, w.guests.pedro, 'interested');

    const first = await rpc<string>(w.alice, 'create_hold', { p_candidate_id: maria, p_expires_at: await dbNowPlus(3600) });
    await rpc(w.bob, 'extend_hold', { p_hold_id: first, p_expires_at: await dbNowPlus(7200) });
    await rpc(w.bob, 'release_hold', { p_hold_id: first, p_reason: 'María asked for more time elsewhere' });
    expect(await outcome(rpc(w.bob, 'release_hold', { p_hold_id: first }))).toBe('HOLD_NOT_ACTIVE');

    // Dates are free again, so Pedro can be held, and his hold converted.
    const second = await rpc<string>(w.bob, 'create_hold', { p_candidate_id: pedro, p_expires_at: await dbNowPlus(3600) });
    const bookingId = await rpc<string>(w.bob, 'confirm_candidate', { p_candidate_id: pedro, p_total_price: 650 });

    const holds = await admin.query(`select id, status, converted_booking_id from public.temporary_holds where id = any($1)`, [[first, second]]);
    expect(holds.rows.find((r) => r.id === first)).toMatchObject({ status: 'released' });
    expect(holds.rows.find((r) => r.id === second)).toMatchObject({ status: 'converted', converted_booking_id: bookingId });
    const types = async (id: string) =>
      (await admin.query(`select event_type from public.hold_events where hold_id = $1 order by event_at, event_type`, [id])).rows.map((r) => r.event_type);
    expect(await types(first)).toEqual(['created', 'extended', 'released']);
    expect(await types(second)).toEqual(['created', 'converted']);
    expect(await activeBookingsOn(w.propA, '2028-02-01', '2028-02-08')).toBe(1);
    const active = await admin.query(
      `select kind from public.availability_allocations where property_id = $1 and active and stay && '[2028-02-01,2028-02-08)'::daterange`,
      [w.propA],
    );
    expect(active.rows).toEqual([{ kind: 'booking' }]);
  });

  it('7. converting a hold cannot race with another user booking the same dates', async () => {
    for (let round = 0; round < 5; round++) {
      const start = `2033-0${round + 1}-10`;
      const end = `2033-0${round + 1}-17`;
      const period = await addPeriod(w.alice, w, w.propA, start, end);
      const maria = await addCandidate(w.alice, w, period, w.guests.maria);
      await rpc(w.alice, 'create_hold', { p_candidate_id: maria, p_expires_at: await dbNowPlus(3600) });
      const s1 = await session(w.alice);
      const s2 = await session(w.bob);
      const [convert, intruder] = await Promise.all([
        outcome(rpcOn(s1, 'confirm_candidate', { p_candidate_id: maria, p_total_price: 700 })),
        outcome(
          rpcOn(s2, 'create_booking', { p_property_id: w.propA, p_guest_id: w.guests.juan, p_start_date: start, p_end_date: end, p_total_price: 1 }),
        ),
      ]);
      await s1.end();
      await s2.end();
      expect(convert).toBe('OK');
      expect(['DATES_HELD', 'DATES_BOOKED']).toContain(intruder);
      expect(await activeBookingsOn(w.propA, start, end)).toBe(1);
    }
  });

  it('8. overriding another candidate\'s hold needs an admin, an explicit hold id and a reason', async () => {
    const period = await addPeriod(w.alice, w, w.propA, '2028-04-01', '2028-04-08');
    const maria = await addCandidate(w.alice, w, period, w.guests.maria);
    const pedro = await addCandidate(w.alice, w, period, w.guests.pedro);
    const holdId = await rpc<string>(w.alice, 'create_hold', { p_candidate_id: maria, p_expires_at: await dbNowPlus(3600) });
    const confirm = (user: string, extra: Record<string, unknown>) =>
      outcome(rpc(user, 'confirm_candidate', { p_candidate_id: pedro, p_total_price: 650, ...extra }));

    expect(await confirm(w.alice, {})).toBe('DATES_HELD'); // never silent
    expect(await confirm(w.bob, { p_override_hold_id: holdId, p_override_reason: 'because' })).toBe('ADMIN_REQUIRED');
    expect(await confirm(w.alice, { p_override_hold_id: holdId, p_override_reason: '  ' })).toBe('OVERRIDE_REASON_REQUIRED');
    expect((await admin.query(`select status from public.temporary_holds where id = $1`, [holdId])).rows[0].status).toBe('active');

    expect(await confirm(w.alice, { p_override_hold_id: holdId, p_override_reason: 'María withdrew by phone' })).toBe('OK');
    const event = await admin.query(`select actor_id, reason from public.hold_events where hold_id = $1 and event_type = 'overridden'`, [holdId]);
    expect(event.rows).toEqual([{ actor_id: w.alice, reason: 'María withdrew by phone' }]);
    expect((await admin.query(`select status from public.booking_candidates where id = $1`, [maria])).rows[0].status).toBe('interested');
  });

  it('9. holds on different properties do not conflict', async () => {
    const p1 = await addPeriod(w.alice, w, w.propA, '2028-05-01', '2028-05-08');
    const p2 = await addPeriod(w.alice, w, w.propA2, '2028-05-01', '2028-05-08');
    const c1 = await addCandidate(w.alice, w, p1, w.guests.ana);
    const c2 = await addCandidate(w.alice, w, p2, w.guests.carlos);
    expect(await outcome(rpc(w.alice, 'create_hold', { p_candidate_id: c1, p_expires_at: await dbNowPlus(3600) }))).toBe('OK');
    expect(await outcome(rpc(w.alice, 'create_hold', { p_candidate_id: c2, p_expires_at: await dbNowPlus(3600) }))).toBe('OK');
  });

  it('9. rejects references to guests or properties of another workspace', async () => {
    const client = await as(w.alice);
    const period = await addPeriod(w.alice, w, w.propA, '2028-07-01', '2028-07-08');
    // A foreign guest in our period: blocked by RLS/composite foreign key.
    const foreignGuest = await outcome(
      client.query(`insert into public.booking_candidates (workspace_id, booking_period_id, guest_id) values ($1,$2,$3)`, [w.wsA, period, w.guestB]),
    );
    expect(foreignGuest).toMatch(/foreign key/);
    // Our workspace id on a foreign property.
    const foreignProperty = await outcome(
      client.query(`insert into public.booking_periods (workspace_id, property_id, start_date, end_date) values ($1,$2,'2028-07-01','2028-07-08')`, [w.wsA, w.propB]),
    );
    expect(foreignProperty).toMatch(/foreign key/);
    expect(
      await outcome(
        rpc(w.alice, 'create_booking', { p_property_id: w.propA, p_guest_id: w.guestB, p_start_date: '2028-07-01', p_end_date: '2028-07-08', p_total_price: 1 }),
      ),
    ).toBe('WORKSPACE_MISMATCH');
    expect(
      await outcome(
        rpc(w.alice, 'create_booking', { p_property_id: w.propB, p_guest_id: w.guests.ana, p_start_date: '2028-07-01', p_end_date: '2028-07-08', p_total_price: 1 }),
      ),
    ).toBe('NOT_A_MEMBER');
  });

  it('freezes period dates while a hold or booking depends on them', async () => {
    const period = await addPeriod(w.alice, w, w.propA2, '2028-08-01', '2028-08-08');
    const c = await addCandidate(w.alice, w, period, w.guests.ana);
    const client = await as(w.alice);
    const move = (end: string) => outcome(client.query(`update public.booking_periods set end_date = $2 where id = $1`, [period, end]));
    expect(await move('2028-08-10')).toBe('OK');
    await rpc(w.alice, 'create_hold', { p_candidate_id: c, p_expires_at: await dbNowPlus(3600) });
    expect(await move('2028-08-12')).toBe('PERIOD_LOCKED');
  });

  it('housekeeping only records what is already true', async () => {
    const period = await addPeriod(w.alice, w, w.propA2, '2028-09-01', '2028-09-08');
    const c = await addCandidate(w.alice, w, period, w.guests.ana);
    const holdId = await rpc<string>(w.alice, 'create_hold', { p_candidate_id: c, p_expires_at: await dbNowPlus(1) });
    await sleep(1300);
    expect(await outcome(rpc(w.alice, 'housekeeping_expire_holds'))).toMatch(/permission denied/);
    await admin.query(`select public.housekeeping_expire_holds()`);
    expect((await admin.query(`select status from public.temporary_holds where id = $1`, [holdId])).rows[0].status).toBe('expired');
  });
});

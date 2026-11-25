import pg from 'pg';
import { inject } from 'vitest';

pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number (test convenience)

export const admin = new pg.Pool({ connectionString: inject('databaseUrl'), max: 4 });

/** A dedicated connection acting as a signed-in Supabase user (or as anon when userId is null). */
export async function session(userId: string | null) {
  const client = new pg.Client({ connectionString: inject('databaseUrl') });
  await client.connect();
  await client.query(`set role ${userId ? 'authenticated' : 'anon'}`);
  await client.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' }),
  ]);
  return client;
}

const sessions = new Map<string, pg.Client>();
export async function as(userId: string | null) {
  const key = userId ?? 'anon';
  if (!sessions.has(key)) sessions.set(key, await session(userId));
  return sessions.get(key)!;
}

export async function rpcOn<T = unknown>(client: pg.Client, fn: string, args: Record<string, unknown> = {}) {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`;
  const res = await client.query(
    sql,
    keys.map((k) => args[k]),
  );
  return res.rows[0].result as T;
}

export async function rpc<T = unknown>(userId: string | null, fn: string, args: Record<string, unknown> = {}) {
  return rpcOn<T>(await as(userId), fn, args);
}

export async function closeAll() {
  for (const client of sessions.values()) await client.end();
  sessions.clear();
  await admin.end();
}

/** Resolves to the Postgres error message (our error code) or 'OK'. */
export async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (error as Error).message;
  }
}

export interface World {
  alice: string; // admin of workspace A
  bob: string; // member of workspace A
  mallory: string; // signed-in user without any membership
  carol: string; // admin of workspace B
  wsA: string;
  wsB: string;
  propA: string;
  propA2: string;
  propB: string;
  guests: Record<'ana' | 'carlos' | 'maria' | 'pedro' | 'juan', string>;
  guestB: string;
}

let counter = 0;
/** Creates two isolated workspaces with users, properties and fictitious guests. */
export async function createWorld(): Promise<World> {
  const n = `${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
  const user = (name: string) => one(`insert into auth.users (email) values ($1) returning id`, [`${name}-${n}@example.test`]);
  const alice = await user('alice');
  const bob = await user('bob');
  const mallory = await user('mallory');
  const carol = await user('carol');
  const ws = (name: string) => one(`insert into public.workspaces (name) values ($1) returning id`, [name]);
  const wsA = await ws(`Familia A ${n}`);
  const wsB = await ws(`Familia B ${n}`);
  await admin.query(
    `insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'admin'),($1,$3,'member'),($4,$5,'admin')`,
    [wsA, alice, bob, wsB, carol],
  );
  const prop = (w: string, name: string) =>
    one(`insert into public.properties (workspace_id, name) values ($1,$2) returning id`, [w, name]);
  const propA = await prop(wsA, 'Casa Salobreña');
  const propA2 = await prop(wsA, 'Apartamento Dos');
  const propB = await prop(wsB, 'Otra Casa');
  const guest = (w: string, name: string) =>
    one(`insert into public.guests (workspace_id, full_name, phone) values ($1,$2,'+34 600 000 000') returning id`, [w, name]);
  const guests = {
    ana: await guest(wsA, 'Ana Ejemplo'),
    carlos: await guest(wsA, 'Carlos Ejemplo'),
    maria: await guest(wsA, 'María Ejemplo'),
    pedro: await guest(wsA, 'Pedro Ejemplo'),
    juan: await guest(wsA, 'Juan Ejemplo'),
  };
  const guestB = await guest(wsB, 'Invitado Ajeno');
  return { alice, bob, mallory, carol, wsA, wsB, propA, propA2, propB, guests, guestB };
}

/** Creates a potential period as the given user through the normal (RLS-protected) path. */
export async function addPeriod(userId: string, w: World, propertyId: string, start: string, end: string) {
  const client = await as(userId);
  const res = await client.query(
    `insert into public.booking_periods (workspace_id, property_id, start_date, end_date) values ($1,$2,$3,$4) returning id`,
    [w.wsA, propertyId, start, end],
  );
  return res.rows[0].id as string;
}

export async function addCandidate(
  userId: string,
  w: World,
  periodId: string,
  guestId: string,
  status = 'interested',
  price: number | null = null,
) {
  const client = await as(userId);
  const res = await client.query(
    `insert into public.booking_candidates (workspace_id, booking_period_id, guest_id, status, proposed_price) values ($1,$2,$3,$4,$5) returning id`,
    [w.wsA, periodId, guestId, status, price],
  );
  return res.rows[0].id as string;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** now + seconds, as an ISO string, taken from the database clock. */
export async function dbNowPlus(seconds: number) {
  const res = await admin.query(`select (clock_timestamp() + make_interval(secs => $1)) as t`, [seconds]);
  return (res.rows[0].t as Date).toISOString();
}

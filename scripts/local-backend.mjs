// Local development / end-to-end test backend. NOT for real data.
//
// Starts a throwaway PostgreSQL (real engine, real migrations, real RLS and RPCs) and a tiny
// HTTP server that speaks just enough of the Supabase REST and Auth protocols for this app:
//   /auth/v1/token, /auth/v1/user, /auth/v1/logout
//   /rest/v1/<table or view>  (GET with eq/neq/gt/gte/lt/lte/in/is filters, order, limit; POST; PATCH)
//   /rest/v1/rpc/<function>
// Every REST request runs in its own transaction as the `authenticated` (or `anon`) role with
// the caller's JWT claims, exactly as PostgREST does, so database security is exercised for real.
// The database is created fresh on every start and deleted on exit.
//
//   node scripts/local-backend.mjs               backend only (http://localhost:54321)
//   node scripts/local-backend.mjs --with-vite   backend + Vite dev server wired to it
//   node scripts/local-backend.mjs --no-seed     empty workspace instead of the demo data
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations, runSqlFile } from './db-setup.mjs';
import { startPostgres } from './pg-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const API_PORT = Number(process.env.LOCAL_API_PORT ?? 54321);
const DB_PORT = Number(process.env.LOCAL_DB_PORT ?? 54322);
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
// Demo accounts for the throwaway database. Override the password with LOCAL_DEV_PASSWORD.
const DEV_PASSWORD = process.env.LOCAL_DEV_PASSWORD ?? 'rental-demo';
const DEV_USERS = ['admin@example.test', 'member@example.test', 'outsider@example.test'];

pg.types.setTypeParser(1082, (v) => v);

// --- JWT (HS256) ---------------------------------------------------------------
const b64 = (input) => Buffer.from(input).toString('base64url');
function signJwt(payload) {
  const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  return `${body}.${crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
}
function verifyJwt(token) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return payload.exp && payload.exp > Date.now() / 1000 ? payload : null;
}
const hashPassword = (password) => crypto.createHash('sha256').update(`local-dev:${password}`).digest('hex');

function sessionFor(user) {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600 * 12;
  const claims = { sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + expiresIn };
  return {
    access_token: signJwt(claims),
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: signJwt({ sub: user.id, kind: 'refresh', exp: now + 3600 * 24 * 30 }),
    user: publicUser(user),
  };
}
const publicUser = (user) => ({
  id: user.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: user.email,
  email_confirmed_at: user.email_confirmed_at,
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: user.created_at,
});

// --- REST helpers ----------------------------------------------------------------
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw httpError(400, 'PGRST100', `invalid identifier: ${name}`);
  return `"${name}"`;
};
const httpError = (status, code, message) => Object.assign(new Error(message), { status, pgrst: { code, message, details: null, hint: null } });
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function buildWhere(searchParams, params) {
  const clauses = [];
  for (const [column, raw] of searchParams) {
    if (RESERVED.has(column)) continue;
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (OPS[op]) {
      params.push(value);
      clauses.push(`${ident(column)} ${OPS[op]} $${params.length}`);
    } else if (op === 'in') {
      params.push(value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')));
      clauses.push(`${ident(column)}::text = any($${params.length})`);
    } else if (op === 'is' && ['null', 'true', 'false'].includes(value)) {
      clauses.push(`${ident(column)} is ${value}`);
    } else if (op === 'not' && value === 'is.null') {
      clauses.push(`${ident(column)} is not null`);
    } else {
      throw httpError(400, 'PGRST100', `unsupported filter: ${column}=${raw}`);
    }
  }
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}
const selectList = (searchParams) => {
  const select = searchParams.get('select');
  return !select || select === '*' ? '*' : select.split(',').map((c) => ident(c.trim())).join(', ');
};
function orderClause(searchParams) {
  const order = searchParams.get('order');
  if (!order) return '';
  const parts = order.split(',').map((item) => {
    const [column, direction] = item.split('.');
    return `${ident(column)} ${direction === 'desc' ? 'desc' : 'asc'}`;
  });
  return `order by ${parts.join(', ')}`;
}

async function handleRest(client, req, url, body) {
  const segments = url.pathname.replace(/^\/rest\/v1\//, '').split('/');
  const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
  const prefer = String(req.headers.prefer ?? '');
  const sp = url.searchParams;

  if (segments[0] === 'rpc') {
    const fn = ident(segments[1]);
    const input = body ?? {};
    const keys = Object.keys(input);
    const values = keys.map((k) => (input[k] !== null && typeof input[k] === 'object' ? JSON.stringify(input[k]) : input[k]));
    const call = `public.${fn}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
    const meta = await client.query(`select bool_or(proretset) as is_set from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [segments[1]]);
    if (meta.rows[0].is_set === null) throw httpError(404, 'PGRST202', `function ${segments[1]} not found`);
    const sql = meta.rows[0].is_set ? `select coalesce(json_agg(t), '[]')::text as out from ${call} t` : `select to_json(${call})::text as out`;
    const res = await client.query(sql, values);
    return { status: 200, text: res.rows[0].out ?? 'null' };
  }

  const table = `public.${ident(segments[0])}`;
  const cols = selectList(sp);
  const wrap = (inner) => `select coalesce(json_agg(x), '[]')::text as out from (${inner}) x`;
  const respond = (text, okStatus = 200) => {
    if (!single) return { status: okStatus, text };
    const rows = JSON.parse(text);
    if (rows.length !== 1) throw httpError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
    return { status: okStatus, text: JSON.stringify(rows[0]) };
  };

  if (req.method === 'GET') {
    const params = [];
    const where = buildWhere(sp, params);
    const limit = sp.get('limit') ? `limit ${Number(sp.get('limit')) | 0}` : '';
    const res = await client.query(wrap(`select ${cols} from ${table} ${where} ${orderClause(sp)} ${limit}`), params);
    return respond(res.rows[0].out);
  }
  if (req.method === 'POST') {
    const rows = Array.isArray(body) ? body : [body ?? {}];
    const columns = Object.keys(rows[0]).map(ident).join(', ');
    let conflict = '';
    if (sp.get('on_conflict') && prefer.includes('resolution=merge-duplicates')) {
      const target = sp.get('on_conflict').split(',').map(ident).join(', ');
      const updates = Object.keys(rows[0]).map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ');
      conflict = `on conflict (${target}) do update set ${updates}`;
    }
    const insert = `insert into ${table} (${columns}) select ${columns} from json_populate_recordset(null::${table}, $1::json) ${conflict} returning *`;
    const res = await client.query(`with r as (${insert}) ${wrap(`select ${cols} from r`)}`, [JSON.stringify(rows)]);
    return prefer.includes('return=representation') ? respond(res.rows[0].out, 201) : { status: 201, text: '' };
  }
  if (req.method === 'PATCH') {
    const params = [JSON.stringify(body ?? {})];
    const columns = Object.keys(body ?? {}).map(ident).join(', ');
    const where = buildWhere(sp, params);
    if (!where) throw httpError(400, 'PGRST100', 'refusing to update without a filter');
    const update = `update ${table} set (${columns}) = (select ${columns} from json_populate_record(null::${table}, $1::json)) ${where} returning *`;
    const res = await client.query(`with r as (${update}) ${wrap(`select ${cols} from r`)}`, params);
    return prefer.includes('return=representation') ? respond(res.rows[0].out) : { status: 204, text: '' };
  }
  throw httpError(405, 'PGRST105', 'method not supported by the local backend');
}

// --- Server ----------------------------------------------------------------------
function send(res, status, payload, origin) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, x-client-info, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Expose-Headers': 'content-range',
  });
  res.end(status === 204 ? undefined : text);
}

function statusForPgError(error) {
  if (error.code === 'P0001') return 400;
  if (error.code === '42501') return 403;
  if (String(error.code).startsWith('23')) return 409;
  return 400;
}

async function main() {
  const database = await startPostgres({ port: DB_PORT });
  await applyMigrations(database.connectionString);
  const owner = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  for (const email of DEV_USERS) {
    await owner.query(`insert into auth.users (email, encrypted_password, created_at) values ($1, $2, now() + ($3 || ' seconds')::interval)`, [
      email,
      hashPassword(DEV_PASSWORD),
      DEV_USERS.indexOf(email),
    ]);
  }
  // The outsider must stay without access, so only the first two exist when the seed picks members.
  if (args.has('--no-seed')) {
    await owner.query(`
      with w as (insert into public.workspaces (name) values ('Familia Demo') returning id),
           m as (insert into public.workspace_members (workspace_id, user_id, role)
                 select w.id, u.id, case when u.email = 'admin@example.test' then 'admin' else 'member' end
                   from w, auth.users u where u.email <> 'outsider@example.test')
      insert into public.properties (workspace_id, name) select id, 'Casa Salobreña' from w`);
  } else {
    await runSqlFile(database.connectionString, path.join(root, 'supabase', 'seed.sql'));
  }
  const api = new pg.Pool({ connectionString: database.connectionString.replace('postgres:postgres@', 'authenticator:authenticator@'), max: 10 });

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') return send(res, 204, '', origin);
    const url = new URL(req.url, `http://localhost:${API_PORT}`);
    let body = null;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      return send(res, 400, { code: 'PGRST102', message: 'invalid JSON body' }, origin);
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const claims = verifyJwt(bearer);

    try {
      if (url.pathname === '/auth/v1/token') {
        let user;
        if (url.searchParams.get('grant_type') === 'password') {
          const found = await owner.query(`select * from auth.users where lower(email) = lower($1)`, [body?.email ?? '']);
          user = found.rows[0];
          if (!user || user.encrypted_password !== hashPassword(body?.password ?? '')) {
            return send(res, 400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' }, origin);
          }
        } else {
          const refresh = verifyJwt(body?.refresh_token);
          const found = refresh?.kind === 'refresh' ? await owner.query(`select * from auth.users where id = $1`, [refresh.sub]) : { rows: [] };
          user = found.rows[0];
          if (!user) return send(res, 400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' }, origin);
        }
        return send(res, 200, sessionFor(user), origin);
      }
      if (url.pathname === '/auth/v1/user') {
        if (!claims) return send(res, 401, { code: 'bad_jwt', message: 'invalid JWT' }, origin);
        if (req.method === 'PUT' && body?.password) {
          await owner.query(`update auth.users set encrypted_password = $2 where id = $1`, [claims.sub, hashPassword(body.password)]);
        }
        const found = await owner.query(`select * from auth.users where id = $1`, [claims.sub]);
        return send(res, 200, publicUser(found.rows[0]), origin);
      }
      if (url.pathname === '/auth/v1/logout') return send(res, 204, '', origin);

      if (url.pathname.startsWith('/rest/v1/')) {
        if (bearer && !claims && bearer !== 'local-anon-key') return send(res, 401, { code: 'PGRST301', message: 'JWT expired' }, origin);
        const client = await api.connect();
        try {
          await client.query('begin');
          await client.query(`set local role ${claims ? 'authenticated' : 'anon'}`);
          await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? { role: 'anon' })]);
          const result = await handleRest(client, req, url, body);
          await client.query('commit');
          return send(res, result.text === '' ? 204 : result.status, result.text, origin);
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          if (error.pgrst) return send(res, error.status, error.pgrst, origin);
          return send(res, statusForPgError(error), { code: error.code ?? 'XX000', message: error.message, details: error.detail ?? null, hint: error.hint ?? null }, origin);
        } finally {
          client.release();
        }
      }
      return send(res, 404, { code: 'not_found', message: 'not found' }, origin);
    } catch (error) {
      console.error(error);
      return send(res, 500, { code: 'XX000', message: String(error.message ?? error) }, origin);
    }
  });
  await new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', resolve));
  console.log(`local backend ready on http://localhost:${API_PORT} (throwaway database on port ${DB_PORT})`);
  console.log(`demo accounts: ${DEV_USERS.join(', ')} - password in LOCAL_DEV_PASSWORD (default documented in README)`);

  let vite;
  if (args.has('--with-vite')) {
    vite = spawn(`npx vite${process.env.VITE_PORT ? ` --port ${Number(process.env.VITE_PORT)}` : ''}`, {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, VITE_SUPABASE_URL: `http://localhost:${API_PORT}`, VITE_SUPABASE_ANON_KEY: 'local-anon-key' },
    });
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    vite?.kill();
    server.close();
    await Promise.allSettled([owner.end(), api.end()]);
    await database.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

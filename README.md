# Rental manager / Gestión de alquileres

Private family tool for managing a vacation rental: prospects, exclusive temporary holds,
bookings, payments, instalment schedules, an occupancy calendar and yearly figures.
Spanish (default) and English. React + TypeScript + Vite, Supabase (PostgreSQL + Auth),
Cloudflare Pages.

- [Architecture, ER model and decisions](docs/ARCHITECTURE.md)
- [RPC contracts and error codes](docs/RPC.md)
- [User guide — Español / English](docs/USER_GUIDE.md)
- [Test report](docs/TEST_REPORT.md)

## Try it locally without a Supabase account

Requires Node 20 or newer.

```
npm install
npm run dev:local
```

Open http://localhost:5173. This starts a **throwaway** PostgreSQL (the real migrations, RLS and
RPCs), a small Supabase-compatible API on port 44321 and Vite. The database is recreated with
fictitious demo data on every start; nothing you enter is kept.

Demo accounts: `admin@example.test`, `member@example.test` and `outsider@example.test` (the last
one has no access, to show the invitation gate). The password is `rental-demo` unless you set
the `LOCAL_DEV_PASSWORD` environment variable before starting.

This local backend (`scripts/local-backend.mjs`) is for development and tests only. It
implements just the REST/Auth calls this app makes; it is not a Supabase replacement.

## Connect a real Supabase project

1. **Create the project** at supabase.com (PostgreSQL 15 or newer; `security_invoker` views
   need it).
2. **Apply the migrations**, in file-name order, from `supabase/migrations/`:
   - with the CLI: `supabase link --project-ref <ref>` then `supabase db push`, or
   - paste each file into the SQL editor and run them one after another.
3. **Authentication settings**
   - *Sign In / Providers → Email*: keep e-mail confirmation on; turn **off** “Allow new users to
     sign up” so accounts are created only by you.
   - *URL Configuration*: set **Site URL** to the production address and add
     `http://localhost:5173` to **Redirect URLs** for local development.
4. **Create the first user** in *Authentication → Users* (add user with a password, or invite by
   e-mail; an invited person follows the link and then sets a password in *Settings* in the app).
5. **Bootstrap the workspace**: open `supabase/bootstrap.sql`, set the admin e-mail, run it once
   in the SQL editor. It creates the workspace, the property “Casa Salobreña” and the admin
   membership, and no fictitious data.
6. **Configure the frontend**: copy `.env.example` to `.env` and fill in

   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon or publishable key>
   ```

   Only the public key belongs here. Never put the service-role key or the database password in
   the frontend or in source control.
7. `npm run dev`, sign in, and invite the rest of the family from *Settings → Family members*.
   An invitation grants access to an e-mail address; the person still needs a user account
   (step 4), and gets access the next time they sign in.

### Development seed (optional, never in production)

`supabase/seed.sql` adds invented guests, overlapping enquiries, an active and an expired hold,
bookings in every status, payments and schedules. It only runs when no workspace exists and at
least one auth user does. The Supabase CLI runs it on `supabase db reset` (local stack); it is
not part of `supabase db push`.

### Optional housekeeping

Availability never depends on a job. To have the persisted `expired` status and audit event
written promptly even when nobody uses the app, schedule (with `pg_cron`, as the owner):
`select public.housekeeping_expire_holds();`

### Generated types

`src/types/database.ts` is written by hand to match the migrations. With a linked project,
`npm run gen:types` writes the generated version to `src/types/database.generated.ts`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server against the Supabase project in `.env` |
| `npm run dev:local` | Local throwaway backend with demo data + Vite |
| `npm run backend:local` | Only the local backend (`--no-seed` for an empty workspace) |
| `npm run smoke:local` | Checks a running local backend through `supabase-js` |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit tests (calculations, dates/DST, localisation) |
| `npm run test:db` | Database integration tests on a real PostgreSQL (RLS, concurrency, holds, payments) |
| `npm run test:e2e` | Playwright end-to-end tests of the main workflows |
| `npm run test:all` | All of the above tests |
| `npm run build` | Typecheck + production build to `dist/` |

The database and end-to-end tests download nothing at run time: PostgreSQL 17 binaries come from
the `embedded-postgres` npm package (copied to the system temp folder on first use, because
Windows cannot execute them from very deep paths). Playwright uses the installed Microsoft Edge;
set `PW_CHANNEL=chrome`, or `PW_CHANNEL=chromium` after `npx playwright install chromium`, to use
another browser.

## Deploy to Cloudflare Pages

1. Push the repository to GitHub/GitLab and create a Pages project from it.
2. Build command `npm run build`, output directory `dist`, Node version 20+.
3. Add the environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Production
   and Preview).
4. SPA routing is handled by `public/_redirects` (`/* /index.html 200`); `public/_headers` adds
   `noindex` and basic security headers.
5. Put the Pages URL (and any custom domain) in Supabase *Site URL* / *Redirect URLs*.

The output is plain static files, so any static host with an SPA fallback works.

## Limitations and what is not verified

- **Deployed on 25 November 2026** to a hosted Supabase project (migrations via
  `npx supabase db push`, login settings via `supabase/config.toml` and `npx supabase config push`)
  and to Cloudflare Pages (`npm run build`, then
  `npx wrangler pages deploy dist --project-name house-rental --branch main`). Checked live: the
  site and its SPA routes load, anonymous API access is refused, public sign-up is closed.
- **The automated tests do not run against the hosted project.** They run on a real PostgreSQL 17
  with a shim that reproduces Supabase's `auth` schema, API roles and default privileges
  (`tests/db/supabase-shim.sql`), and end-to-end through the local backend. The signed-in smoke
  path on the live site (create a hold, confirm a booking, record a payment) is a manual check.
- No Supabase Realtime: other people's changes appear on refocus, after any action, when a hold
  deadline passes, or within a minute.
- The in-app invitation does not send e-mail and does not create the user account.
- No offline mode; no payment processing, bank feeds, taxes, expenses or accounting; no
  refundable damage deposits (the deposit tracked is part of the rental price).
- Archiving and anonymising guests are technical tools; they do not by themselves make the use
  of the app compliant with data-protection or tax law.
- The annual calendar overview is view-only detail per day; there is no drag-and-drop.

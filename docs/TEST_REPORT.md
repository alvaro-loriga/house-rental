# Test report

Run on 24 November 2026, Windows 11, Node 26.13, PostgreSQL 17.12 (embedded binaries),
Microsoft Edge via Playwright 1.65.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | no errors |
| Unit tests | `npm test` | 41 passed, 0 failed (3 files) |
| Database integration tests | `npm run test:db` | 32 passed, 0 failed (2 files) |
| End-to-end tests | `npm run test:e2e` | 12 passed, 0 failed |
| Production build | `npm run build` | succeeded (one chunk-size advisory: 736 kB JS, 209 kB gzipped) |
| Local backend smoke check | `npm run smoke:local` | 18 of 18 checks ok |

## What was *not* run

- The automated suites above did not run against hosted Supabase. Database behaviour was tested
  on plain PostgreSQL with `tests/db/supabase-shim.sql`; the HTTP layer in end-to-end tests is
  `scripts/local-backend.mjs`.
- Deployment on 25 November 2026 (hosted Supabase, PostgreSQL 17.12, and Cloudflare Pages) was
  checked by hand only: four migrations applied, 16 of 16 tables with row-level security, five
  tables/views and one RPC refuse anonymous requests (401), sign-up closed, the site and its SPA
  routes return 200 with the security headers, the sign-in page renders without console errors.
  No signed-in workflow was exercised on the live site as part of that check.
- `npm run gen:types` (needs a linked project).
- No real phone or tablet; mobile layouts were tested as browser viewports (320×640, 375×812,
  812×375) plus 1280×800.
- Browsers other than Edge (Chromium).
- The Android contact picker itself: tests use a stand-in for `navigator.contacts`; it was not
  run on a real phone as part of the test suite.

## Acceptance criteria coverage

| # | Criterion | Where it is tested |
|---|---|---|
| 1 | Several undecided candidates on identical / overlapping dates coexist | db `availability.test.ts` “1.”; e2e workflow A |
| 2 | Confirming a candidate creates one booking and updates status atomically | db “2.” (+ repeat confirmation refused); e2e workflow A |
| 3 | Conflicting confirmed bookings rejected, including simultaneous sessions | db “3.” ×3: RPC rejection, five rounds of two concurrent sessions (exactly one wins), raw exclusion constraint `23P01` |
| 4 | Adjacent check-out / check-in allowed | db “4.”; unit `rangesOverlap`, `availabilityFor` |
| 5 | Active hold blocks bookings and holds, not enquiries | db “5.” ×2; e2e workflow B |
| 6 | Hold expires on database time with no session or job; others can then book | db “6.” (real wait past the deadline; persisted status still `active`, views already report expired; `expired` event with null actor) |
| 7 | Extend, release, convert; conversion cannot race | db “7.” ×2 (five rounds of conversion vs. a competing booking); e2e workflow B |
| 8 | Override needs explicit authorisation and an audit reason | db “8.” (member → `ADMIN_REQUIRED`, blank reason refused, event recorded); e2e workflow B (admin and member views) |
| 9 | Holds on different properties do not conflict; cross-workspace references rejected | db “9.” ×2 |
| 10 | 700 + 200 = 500 outstanding; refunds and voids adjust and are audited | db “10.” ×2; e2e workflows A and D; smoke check |
| 11 | Ten instalments of 550 = 5,500; future ones not overdue; crossing years | db “11.”; unit pricing / finance tests (year split to the cent); e2e workflow C |
| 12 | Cancellation releases dates, keeps payments; completed stays stay in reporting | db “12.” ×2; unit year report; e2e workflow D |
| 13 | Unauthenticated and non-member accounts have no access; members collaborate | db “13.” ×6 (all 22 tables/views for anon and for a non-member, RPC refusals, invitation flow, unconfirmed e-mail, last admin); e2e access test |
| 14 | ES/EN switching on core screens, persistence, form state kept | unit `i18n.test.tsx` (key parity, every used key present, vocabulary, validation messages, same DOM node after switch); e2e language test (8 screens in both languages, reload, account-level persistence) |
| 15 | Madrid DST and devices in another time zone | unit tests run with `TZ=America/New_York`; DST conversions for 28 Mar and 31 Oct 2027; db hold cut-off on both DST days; e2e runs with the browser in New York and asserts “mañana a las 20:00” |
| 16 | Mobile and desktop without horizontal overflow or unreachable controls | e2e layout tests ×4 viewports over 12 routes (scroll width, bottom navigation in view, 44 px targets, menu reachable, real table on desktop) |

## Notes from the test runs

- The first run of the unit suite found a real defect in `zonedTimeToInstant`: an ambiguous
  autumn time (02:30 on 31 October) resolved to the second occurrence instead of the first. It
  was fixed and is now covered.
- The concurrency tests use genuinely separate connections issuing requests at the same time;
  each scenario is repeated five times.
- End-to-end tests share one seeded database and run serially (they build on each other).

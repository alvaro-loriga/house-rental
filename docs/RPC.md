# RPC contracts and error codes

All functions live in schema `public`, are `SECURITY DEFINER`, require a signed-in user and
check workspace membership themselves. They are called with named arguments, e.g.
`supabase.rpc('create_hold', { p_candidate_id, p_expires_at })`. Typed wrappers are in
`src/services/api.ts`.

Errors are raised with SQLSTATE `P0001`; `message` is one of the codes below and `details` is a
JSON object with context. The UI maps codes to `errors.<CODE>` in the dictionaries.

## Holds

| Function | Arguments | Returns | Notes |
|---|---|---|---|
| `create_hold` | `p_candidate_id uuid`, `p_expires_at timestamptz`, `p_notes text = null` | `uuid` hold id | Dates come from the candidate's period. Fails if the dates are booked/held, the deadline is past or after check-in, or the candidate is confirmed/discarded. |
| `extend_hold` | `p_hold_id uuid`, `p_expires_at timestamptz` | `void` | Any future deadline up to the check-in cut-off. |
| `release_hold` | `p_hold_id uuid`, `p_reason text = null` | `void` | Frees the dates immediately. |

## Bookings

| Function | Arguments | Returns | Notes |
|---|---|---|---|
| `confirm_candidate` | `p_candidate_id uuid`, `p_total_price numeric`, `p_pricing_type text = 'total'`, `p_unit_price numeric = null`, `p_deposit_required numeric = 0`, `p_notes text = null`, `p_discard_others boolean = false`, `p_override_hold_id uuid = null`, `p_override_reason text = null` | `uuid` booking id | Atomic: booking + allocation + candidate `confirmed` + period `booked` + own hold `converted`. Another candidate's hold needs admin + its id + reason. |
| `create_booking` | `p_property_id`, `p_guest_id`, `p_start_date date`, `p_end_date date`, `p_total_price numeric`, `p_pricing_type = 'total'`, `p_unit_price = null`, `p_status = 'confirmed'`, `p_deposit_required = 0`, `p_notes = null` | `uuid` | Direct booking. `p_status` is `provisional` (non-blocking) or `confirmed`. |
| `update_booking` | `p_booking_id`, `p_start_date`, `p_end_date`, `p_total_price`, `p_pricing_type`, `p_unit_price`, `p_deposit_required`, `p_notes` | `void` | Re-checks conflicts when a blocking booking's dates change. Not allowed on cancelled bookings. |
| `set_booking_status` | `p_booking_id`, `p_status text`, `p_reason text = null`, `p_cancellation_fee numeric = null` | `void` | `provisional→confirmed|cancelled`, `confirmed→completed|cancelled` (reason required), `completed→confirmed`. |

## Payments

| Function | Arguments | Returns | Notes |
|---|---|---|---|
| `record_payment` | `p_booking_id`, `p_amount numeric`, `p_payment_date date`, `p_payment_method text`, `p_payment_type text`, `p_notes text = null` | `uuid` | Amount > 0. A `refund` may not exceed net receipts. |
| `correct_payment` | `p_payment_id`, `p_amount`, `p_payment_date`, `p_payment_method`, `p_payment_type`, `p_notes`, `p_reason text` | `void` | Reason required; old and new values are audited. |
| `void_payment` | `p_payment_id`, `p_reason text` | `void` | Reason required; the row stays, flagged as voided. |
| `set_installments` | `p_booking_id`, `p_items jsonb` | `integer` rows | Replaces the whole schedule: `[{"due_date":"2027-09-01","amount":550,"description":"1/10"}]`. |

## Membership

| Function | Arguments | Returns | Who |
|---|---|---|---|
| `accept_invitations` | – | `integer` workspaces joined | any signed-in user (confirmed e-mail only) |
| `list_members` | `p_workspace_id` | `table(user_id, email, role, created_at)` | members |
| `invite_member` | `p_workspace_id`, `p_email`, `p_role = 'member'` | `uuid` | admins |
| `revoke_invitation` | `p_invitation_id` | `void` | admins |
| `remove_member` | `p_workspace_id`, `p_user_id` | `void` | admins |
| `set_member_role` | `p_workspace_id`, `p_user_id`, `p_role` | `void` | admins |

`is_workspace_member(uuid)` and `is_workspace_admin(uuid)` are helper predicates used by RLS.
`housekeeping_expire_holds()` is not granted to API roles (owner / `pg_cron` only).

## Error codes

| Code | Meaning | `details` |
|---|---|---|
| `NOT_AUTHENTICATED` | No signed-in user | |
| `NOT_A_MEMBER` | Caller is not a member of the workspace | |
| `ADMIN_REQUIRED` | Admin role needed | |
| `NOT_FOUND` | Record does not exist | |
| `INVALID_DATES` | Missing dates or check-out not after check-in | |
| `INVALID_AMOUNT` | Missing, negative, zero where positive is required, or more than two decimals | |
| `INVALID_PRICING_TYPE`, `INVALID_PAYMENT_METHOD`, `INVALID_PAYMENT_TYPE`, `INVALID_ROLE`, `INVALID_EMAIL`, `INVALID_TIMEZONE` | Unknown identifier / malformed value | |
| `INVALID_STATUS_TRANSITION` | Booking status change not allowed | `from`, `to` |
| `DATES_BOOKED` | A confirmed/completed booking overlaps | `booking_id`, `guest_name`, `start_date`, `end_date` |
| `DATES_HELD` | An effective hold overlaps | `hold_id`, `candidate_id`, `guest_name`, `start_date`, `end_date`, `expires_at` |
| `HOLD_EXPIRED` | The hold's deadline has passed | `expires_at` |
| `HOLD_NOT_ACTIVE` | The hold was released or converted | `status` |
| `HOLD_EXPIRY_IN_PAST` | Deadline is not in the future | |
| `HOLD_EXPIRY_AFTER_CHECKIN` | Deadline is later than the check-in cut-off | `cutoff` |
| `OVERRIDE_REASON_REQUIRED` | Override requested without a reason | |
| `REASON_REQUIRED` | A reason is mandatory for this action | |
| `REFUND_EXCEEDS_RECEIPTS` | Refund / void / correction would make net receipts negative | `net_paid` |
| `PAYMENT_VOIDED` | The payment is already voided | |
| `CANDIDATE_NOT_ELIGIBLE` | Candidate is already confirmed or discarded | `status` |
| `WORKSPACE_MISMATCH` | Referenced record belongs to another workspace | |
| `BOOKING_NOT_EDITABLE` | Cancelled bookings cannot be edited | |
| `PERIOD_LOCKED` | Period dates are frozen by an active hold or a booking | |
| `DIRECT_WRITE_FORBIDDEN` | A direct table write tried to do what only an RPC may do | |
| `ALREADY_A_MEMBER`, `LAST_ADMIN` | Membership rules | |

Client-side only (derived in `src/utils/errors.ts`): `DATES_UNAVAILABLE` (exclusion constraint
`23P01`, a last-line safety net), `DUPLICATE` (`23505`), `FORBIDDEN` (`42501` / 401 / 403),
`INVALID_CREDENTIALS`, `NETWORK`, `UNKNOWN`.

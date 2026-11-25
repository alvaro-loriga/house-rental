// Maps anything the backend can throw to a stable code the UI can translate.
// Codes raised by our RPCs arrive as the PostgreSQL error message (see docs/RPC.md).

export const KNOWN_ERROR_CODES = [
  'NOT_AUTHENTICATED',
  'NOT_A_MEMBER',
  'ADMIN_REQUIRED',
  'NOT_FOUND',
  'INVALID_DATES',
  'INVALID_AMOUNT',
  'INVALID_PRICING_TYPE',
  'INVALID_PAYMENT_METHOD',
  'INVALID_PAYMENT_TYPE',
  'INVALID_STATUS_TRANSITION',
  'INVALID_TIMEZONE',
  'INVALID_EMAIL',
  'INVALID_ROLE',
  'DATES_BOOKED',
  'DATES_HELD',
  'DATES_UNAVAILABLE',
  'HOLD_EXPIRED',
  'HOLD_NOT_ACTIVE',
  'HOLD_EXPIRY_IN_PAST',
  'HOLD_EXPIRY_AFTER_CHECKIN',
  'OVERRIDE_REASON_REQUIRED',
  'REASON_REQUIRED',
  'REFUND_EXCEEDS_RECEIPTS',
  'PAYMENT_VOIDED',
  'CANDIDATE_NOT_ELIGIBLE',
  'WORKSPACE_MISMATCH',
  'BOOKING_NOT_EDITABLE',
  'PERIOD_LOCKED',
  'DIRECT_WRITE_FORBIDDEN',
  'ALREADY_A_MEMBER',
  'LAST_ADMIN',
  'DUPLICATE',
  'FORBIDDEN',
  'INVALID_CREDENTIALS',
  'NETWORK',
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ErrorCode, detail: Record<string, unknown> = {}, cause?: unknown) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }
}

interface BackendError {
  message?: string;
  code?: string;
  details?: string | null;
  status?: number;
  name?: string;
}

function parseDetail(details: string | null | undefined): Record<string, unknown> {
  if (!details) return {};
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = (error ?? {}) as BackendError;
  const message = e.message ?? '';
  if ((KNOWN_ERROR_CODES as readonly string[]).includes(message)) {
    return new AppError(message as ErrorCode, parseDetail(e.details), error);
  }
  // Safety nets for errors raised by constraints rather than by our own checks.
  if (e.code === '23P01') return new AppError('DATES_UNAVAILABLE', {}, error);
  if (e.code === '23505') return new AppError('DUPLICATE', {}, error);
  if (e.code === '42501' || e.code === 'PGRST301' || e.status === 401 || e.status === 403) return new AppError('FORBIDDEN', {}, error);
  if (/invalid login credentials/i.test(message) || e.code === 'invalid_credentials') return new AppError('INVALID_CREDENTIALS', {}, error);
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed|fetch failed/i.test(message) || e.name === 'AuthRetryableFetchError') {
    return new AppError('NETWORK', {}, error);
  }
  return new AppError('UNKNOWN', { message }, error);
}

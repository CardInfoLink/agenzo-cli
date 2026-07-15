import { type ErrorCode, CODE_NUM, codeNum } from './error-catalog.js';
import type { ApiError, UpstreamError } from '../api-client/client.js';

/** Base class for all CLI errors. Carries the CLI-facing error code (§8.4). */
export class CliError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode?: number,
    public readonly requestId?: string,
    public readonly upstream?: UpstreamError,
    /**
     * The backend's own raw message for this error (e.g. a Pydantic
     * validation detail such as "child_seat_count: must be between 0 and 5",
     * or a provider adapter's `user_hint`). Kept SEPARATE from `message`
     * (the stable, catalog-owned text for `code`) so callers always get a
     * predictable top-level message while still being able to see exactly
     * what the backend said. Surfaced in the envelope as `backend_message`
     * when present and different from the stable message.
     */
    public readonly backendMessage?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }

  /**
   * Map a backend ApiError to a CLI-facing code (§8.5 transitional mapping).
   * Backend numeric codes / HTTP status are translated to §8.4 string codes.
   * The top-level `message` is always the stable, catalog-owned text for the
   * resolved code (§8.1 principle 4 — never let raw backend text become the
   * primary/stable message). The backend's own message is NOT discarded,
   * though: it is preserved on `backendMessage` and surfaced in the envelope
   * as `backend_message` so the caller can see the real reason (e.g. which
   * field failed validation) alongside the stable code/message.
   *
   * The optional `opts.auth` selects the auth semantics for the 401 mapping:
   * - `'bearer'` (default, admin-cli Bearer Token): 401 → `AUTH_SESSION_EXPIRED`.
   * - `'api-key'` (token-cli `X-Api-Key`): 401 → `KEY_INVALID`.
   * 403 maps to `KEY_SCOPE_DENIED` under both auth modes. Omitting `opts`
   * preserves the original Bearer behavior exactly (§8.5 / requirement 6.4).
   *
   * Domain string-code routing (D3 / requirement 5.4): when the backend
   * supplies a string `error.code` in the v3 envelope that is a known §8 code
   * (present in {@link CODE_NUM}), it is used verbatim as the CLI-facing code
   * so ride/merchant-specific codes (`QUOTE_EXPIRED`, `VEHICLE_UNAVAILABLE`,
   * `BILLING_MODE_MISMATCH`, `PAYMENT_ORDER_*`, …) survive intact. Otherwise —
   * including when no string code is provided, as is the case for admin/token
   * today — mapping falls back to the HTTP-status table below, leaving the
   * existing Bearer/api-key behavior unchanged.
   */
  static fromApi(error: ApiError, opts?: { auth?: 'bearer' | 'api-key' }): CliError {
    // D3: prefer the backend's string code when it is a known §8 catalog code.
    if (error.code && isKnownErrorCode(error.code)) {
      return new CliError(
        error.code,
        STABLE_MESSAGE[error.code] ?? 'Request failed. Please check your input and retry.',
        error.statusCode,
        error.requestId,
        error.upstream,
        error.errorMessage,
      );
    }

    const status = error.statusCode;
    let code: ErrorCode;

    if (status === 401) code = opts?.auth === 'api-key' ? 'KEY_INVALID' : 'AUTH_SESSION_EXPIRED';
    else if (status === 403) code = 'KEY_SCOPE_DENIED';
    else if (status === 404) code = 'RESOURCE_NOT_FOUND';
    else if (status === 409) code = 'RESOURCE_CONFLICT';
    else if (status === 429) code = 'RATE_LIMITED';
    else if (status >= 500) code = 'INTERNAL_ERROR';
    else code = 'PARAM_INVALID'; // other 4xx (incl. 400/422)

    return new CliError(
      code,
      STABLE_MESSAGE[code] ?? 'Request failed. Please check your input and retry.',
      status,
      error.requestId,
      error.upstream,
      error.errorMessage,
    );
  }
}

/** Network / connectivity failure → UPSTREAM_ERROR. Never leak the internal URL/path. */
export class NetworkError extends CliError {
  constructor(_url: string, timeout?: number, _cause?: Error) {
    super(
      'UPSTREAM_ERROR',
      timeout
        ? 'The request timed out. The service may be temporarily unavailable — please retry.'
        : 'Connection failed. The service may be temporarily unavailable — please retry.',
    );
  }
}

/** Auth / session failures. Code chosen by message intent (§8.4 AUTH_* / CLIENT_*). */
export class AuthError extends CliError {
  constructor(message: string, public readonly suggestion: string) {
    const m = message.toLowerCase();
    const code: ErrorCode = m.includes('not signed in')
      ? 'CLIENT_NOT_SIGNED_IN'
      : m.includes('time')
        ? 'CLIENT_LOGIN_TIMEOUT'
        : m.includes('magic link')
          ? 'AUTH_MAGIC_LINK_EXPIRED'
          : 'AUTH_SESSION_EXPIRED';
    super(code, message || 'Unknown error');
  }
}

export class ConfigError extends CliError {
  constructor(message: string, public readonly filePath: string) {
    super('INTERNAL_ERROR', message || 'Unknown error');
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super('PARAM_INVALID', message || 'Unknown error');
  }
}

export class IdempotencyKeyRequiredError extends CliError {
  constructor(commandPath: string) {
    super(
      'PARAM_IDEMPOTENCY_KEY_REQUIRED',
      `\`${commandPath}\` requires --idempotency-key <key>. Supply a unique key so the write can be safely retried.`,
    );
  }
}

export class UpgradeRequiredError extends CliError {
  constructor(currentVersion: string, minVersion: string, upgradeCommand: string) {
    super(
      'UPGRADE_REQUIRED',
      `agenzo-admin-cli ${currentVersion} is out of date — the server requires ${minVersion} or newer. To upgrade, run: ${upgradeCommand}`,
    );
  }
}

export class UserCancelError extends CliError {
  constructor(message = 'Operation cancelled by user') {
    super('CLIENT_ABORTED', message || 'Unknown error');
  }
}

/** Type guard: is `value` a known §8 string error code (present in CODE_NUM)? */
function isKnownErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(CODE_NUM, value);
}

/**
 * Stable, CLI-owned message per code used when mapping opaque backend errors
 * (§8.1 principle 4: never surface raw backend detail).
 */
const STABLE_MESSAGE: Partial<Record<ErrorCode, string>> = {
  AUTH_SESSION_EXPIRED: 'Your session has expired. Please run `agenzo-admin-cli auth login` again.',
  AUTH_MAGIC_LINK_EXPIRED: 'Verification link is invalid or has expired. Please request a new one.',
  AUTH_INVITE_CODE_REQUIRED: 'An invitation code is required to register.',
  AUTH_INVITE_CODE_INVALID: 'The invitation code is invalid.',
  KEY_INVALID: 'The API key is invalid or has been revoked. Please check your --api-key and retry.',
  KEY_SCOPE_DENIED: 'This API key does not have the required scope for this command.',
  PAYMENT_METHOD_NOT_FOUND: 'Payment method not found.',
  PAYMENT_METHOD_DISABLED: 'This payment method has been disabled.',
  INVALID_PAYMENT_METHOD: 'The payment method is not available for this operation.',
  RESOURCE_NOT_FOUND: 'The resource was not found or does not belong to the current organization.',
  RESOURCE_CONFLICT: 'A resource with the same unique value already exists.',
  RESOURCE_STATE_INVALID: 'The resource is in a state that does not permit this operation.',
  RATE_LIMITED: 'Too many requests. Please back off and retry.',
  UPSTREAM_ERROR: 'A third-party service is temporarily unavailable. Please try again later.',
  INTERNAL_ERROR: 'Something went wrong on the server. Please retry and note the request_id.',
  PARAM_INVALID: 'One or more parameters are invalid. Please check your input and retry.',
  PARAM_IDEMPOTENCY_KEY_CONFLICT: 'A request with this idempotency key was already processed with different parameters.',
  TOKEN_FEATURE_DISABLED: 'VCN creation is not supported yet. Coming soon.',
  BILLING_MODE_MISMATCH: 'The billing mode does not match this operation. Please verify your account billing configuration.',
  ACCOUNT_NOT_FOUND: 'The settlement account was not found.',
  ACCOUNT_SUSPENDED: 'The settlement account is suspended. Please contact support.',
  ACCOUNT_INSUFFICIENT_BALANCE: 'The settlement account has insufficient balance for this operation.',
  PAYMENT_ORDER_NOT_FOUND: 'The payment order was not found.',
  PAYMENT_ORDER_NOT_PAID: 'The payment order has not been paid. Please complete payment and retry.',
  PAYMENT_ORDER_MISMATCH: 'The payment order does not match this order. Please check the --payment-order-id.',
  PAYMENT_ORDER_ALREADY_CONSUMED: 'The payment order has already been consumed by another booking.',
  SERVICE_NOT_FOUND: 'The requested service was not found.',
  VEHICLE_UNAVAILABLE: 'No vehicle is available for the requested trip. Please try a different time or class.',
  QUOTE_EXPIRED: 'The quote has expired. Please request a new quote and retry.',
  BOOKING_FAILED: 'The booking could not be completed. Please retry.',
  PRICE_MISMATCH: 'The price does not match the quote. Re-quote and use the exact amount from the quote response.',
  VEHICLE_CLASS_MISMATCH: 'The vehicle class does not match the quote. Use the vehicle class from the quote response.',
  PAYMENT_METHOD_REQUIRED: 'Pay-per-call billing requires an active payment method. Please add a card first.',
  QUOTE_CACHE_UNAVAILABLE: 'Quote cache is temporarily unavailable. Please request a new quote and retry.',
  ARREARS_OUTSTANDING: 'You have outstanding arrears. Please settle your balance before booking a new ride.',
  CONTACT_REQUIRED: 'Passenger contact information is required. Please provide a passenger name and phone number.',
  INVALID_PHONE: 'The passenger phone number is not valid. Please provide a valid international number.',
  SEAT_LIMIT_EXCEEDED: 'The number of child/infant/toddler seats exceeds the vehicle capacity. Reduce seats or choose a larger vehicle.',
  RIDE_NOT_FOUND: 'The ride order was not found or does not belong to you.',
  CANCELLATION_NOT_ALLOWED: 'This order cannot be cancelled in its current state.',
  NO_AVAILABILITY: 'No rooms available for the selected hotel and dates.',
  PRICE_CHANGED: 'The price changed since the quote. Re-quote and confirm.',
  NAME_FORMAT_INVALID: 'The guest name format is not accepted; use Latin letters.',
  HOTEL_ORDER_NOT_FOUND: 'Hotel order not found.',
  ALREADY_CANCELLED: 'This hotel order is already cancelled.',
  CHECKOUT_NOT_ALLOWED: 'A partial check-out is not allowed in the current state.',
  CHECKOUT_TASK_NOT_FOUND: 'Check-out application not found.',
  PAY_PER_CALL_NOT_AVAILABLE: 'Pay-per-call billing is not available; use monthly_settlement.',
  HOTEL_NOT_FOUND: 'This hotel is no longer available from the supplier.',
  NOT_IMPLEMENTED: 'This operation is not implemented yet.',
};

/**
 * §8.2 error envelope: `{ error: { code, code_num, message, request_id?, upstream?, backend_message? } }`.
 *
 * `message` is always the stable, catalog-owned text for `code` — safe to
 * match on and never changes shape. `backend_message` (when present) is the
 * backend's own raw text for this specific failure (e.g. which field failed
 * validation, or a provider's real rejection reason) — diagnostic, not a
 * stable contract, but no longer discarded.
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    code_num: number;
    message: string;
    request_id?: string;
    upstream?: UpstreamError;
    backend_message?: string;
  };
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof CliError) {
    const stableMessage = error.message || 'Unknown error';
    // Only surface backend_message when it adds information beyond the
    // stable message (avoid noisy duplication when they already match).
    const backendMessage =
      error.backendMessage && error.backendMessage !== stableMessage
        ? error.backendMessage
        : undefined;
    return {
      error: {
        code: error.code,
        code_num: codeNum(error.code),
        message: stableMessage,
        ...(error.requestId ? { request_id: error.requestId } : {}),
        ...(error.upstream ? { upstream: error.upstream } : {}),
        ...(backendMessage ? { backend_message: backendMessage } : {}),
      },
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unexpected error';
  return {
    error: {
      code: 'INTERNAL_ERROR',
      code_num: codeNum('INTERNAL_ERROR'),
      message: message || 'Unknown error',
    },
  };
}

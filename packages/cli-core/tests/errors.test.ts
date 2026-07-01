import { describe, it, expect } from 'vitest';
import {
  toErrorEnvelope,
  CliError,
  AuthError,
  ConfigError,
  NetworkError,
  UpgradeRequiredError,
  UserCancelError,
  ValidationError,
} from '../errors/errors.js';
import { CODE_NUM, type ErrorCode } from '../errors/error-catalog.js';

const ALL_CODES = Object.keys(CODE_NUM) as ErrorCode[];

describe('error-catalog toErrorEnvelope mapping (§8.4)', () => {
  it('UT-ERR-01: UpgradeRequiredError -> UPGRADE_REQUIRED', () => {
    expect(toErrorEnvelope(new UpgradeRequiredError('a', 'b', 'c')).error.code).toBe('UPGRADE_REQUIRED');
  });

  it('UT-ERR-02: AuthError (not signed in) -> CLIENT_NOT_SIGNED_IN', () => {
    expect(toErrorEnvelope(new AuthError('Not signed in', 'run login')).error.code).toBe('CLIENT_NOT_SIGNED_IN');
  });

  it('UT-ERR-03: AuthError (session expired) -> AUTH_SESSION_EXPIRED', () => {
    expect(toErrorEnvelope(new AuthError('Session expired, please refresh', 's')).error.code).toBe(
      'AUTH_SESSION_EXPIRED',
    );
  });

  it('UT-ERR-04: AuthError (login timeout) -> CLIENT_LOGIN_TIMEOUT', () => {
    expect(toErrorEnvelope(new AuthError('Login timed out', 's')).error.code).toBe('CLIENT_LOGIN_TIMEOUT');
  });

  it('UT-ERR-05: ApiBusinessError 401 -> AUTH_SESSION_EXPIRED', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1002, errorMessage: 'm', statusCode: 401 })).error.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('UT-ERR-06: ApiBusinessError 403 -> KEY_SCOPE_DENIED', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1102, errorMessage: 'm', statusCode: 403 })).error.code).toBe('KEY_SCOPE_DENIED');
  });

  it('UT-ERR-06a: default/bearer 401 unchanged -> AUTH_SESSION_EXPIRED', () => {
    expect(CliError.fromApi({ success: false, errorCode: 1002, errorMessage: 'm', statusCode: 401 }, { auth: 'bearer' }).code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('UT-ERR-06b: api-key 401 -> KEY_INVALID', () => {
    expect(CliError.fromApi({ success: false, errorCode: 1002, errorMessage: 'm', statusCode: 401 }, { auth: 'api-key' }).code).toBe('KEY_INVALID');
  });

  it('UT-ERR-06c: api-key 403 -> KEY_SCOPE_DENIED', () => {
    expect(CliError.fromApi({ success: false, errorCode: 1102, errorMessage: 'm', statusCode: 403 }, { auth: 'api-key' }).code).toBe('KEY_SCOPE_DENIED');
  });

  it('UT-ERR-06d: api-key non-auth status unaffected (404 -> RESOURCE_NOT_FOUND)', () => {
    expect(CliError.fromApi({ success: false, errorCode: 1201, errorMessage: 'm', statusCode: 404 }, { auth: 'api-key' }).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('UT-ERR-07: ApiBusinessError 404 -> RESOURCE_NOT_FOUND', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1201, errorMessage: 'm', statusCode: 404 })).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('UT-ERR-09: ApiBusinessError 409 -> RESOURCE_CONFLICT', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1004, errorMessage: 'm', statusCode: 409 })).error.code).toBe('RESOURCE_CONFLICT');
  });

  it('UT-ERR-10: ApiBusinessError 429 -> RATE_LIMITED', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1429, errorMessage: 'm', statusCode: 429 })).error.code).toBe('RATE_LIMITED');
  });

  it('UT-ERR-11: ApiBusinessError other 4xx -> PARAM_INVALID', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 2101, errorMessage: 'm', statusCode: 422 })).error.code).toBe('PARAM_INVALID');
  });

  it('UT-ERR-12: ApiBusinessError 5xx -> INTERNAL_ERROR', () => {
    expect(toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 5000, errorMessage: 'm', statusCode: 503 })).error.code).toBe('INTERNAL_ERROR');
  });

  it('UT-ERR-12a: D3 known backend string code routes by code (QUOTE_EXPIRED over HTTP 410)', () => {
    const err = CliError.fromApi(
      { success: false, errorCode: 0, errorMessage: 'expired', statusCode: 410, code: 'QUOTE_EXPIRED' },
      { auth: 'api-key' },
    );
    expect(err.code).toBe('QUOTE_EXPIRED');
    // raw backend message is NOT surfaced (§8.1 principle 4)
    expect(err.message).not.toBe('expired');
  });

  it('UT-ERR-12b: D3 string code wins over HTTP status (VEHICLE_UNAVAILABLE over 404)', () => {
    const err = CliError.fromApi(
      { success: false, errorCode: 0, errorMessage: 'm', statusCode: 404, code: 'VEHICLE_UNAVAILABLE' },
      { auth: 'api-key' },
    );
    expect(err.code).toBe('VEHICLE_UNAVAILABLE');
  });

  it('UT-ERR-12c: D3 routes merchant codes verbatim (BILLING_MODE_MISMATCH, PAYMENT_ORDER_MISMATCH)', () => {
    expect(CliError.fromApi({ success: false, errorCode: 0, errorMessage: 'm', statusCode: 422, code: 'BILLING_MODE_MISMATCH' }).code).toBe('BILLING_MODE_MISMATCH');
    expect(CliError.fromApi({ success: false, errorCode: 0, errorMessage: 'm', statusCode: 422, code: 'PAYMENT_ORDER_MISMATCH' }).code).toBe('PAYMENT_ORDER_MISMATCH');
  });

  it('UT-ERR-12f: INVALID_PAYMENT_METHOD (backend 1403, HTTP 400) routes verbatim, NOT a PARAM_INVALID fallback', () => {
    // Regression: backend sends error_code="INVALID_PAYMENT_METHOD" (1403) at HTTP 400.
    // Before this code was added to the CLI catalog, isKnownErrorCode() returned
    // false and this fell through to the generic 4xx branch -> PARAM_INVALID
    // (2101), losing the real reason (e.g. "card does not support this payment
    // type") behind a generic "check your input" message.
    const err = CliError.fromApi(
      { success: false, errorCode: 1403, errorMessage: 'This card does not support this payment type.', statusCode: 400, code: 'INVALID_PAYMENT_METHOD' },
      { auth: 'api-key' },
    );
    expect(err.code).toBe('INVALID_PAYMENT_METHOD');
    expect(err.code).not.toBe('PARAM_INVALID');
    // The real backend reason is preserved (not the stable message) for diagnostics.
    expect(err.backendMessage).toBe('This card does not support this payment type.');
  });

  it('UT-ERR-12g: PAYMENT_METHOD_NOT_FOUND (1401) and PAYMENT_METHOD_DISABLED (1402) route verbatim', () => {
    expect(CliError.fromApi({ success: false, errorCode: 1401, errorMessage: 'm', statusCode: 404, code: 'PAYMENT_METHOD_NOT_FOUND' }).code).toBe('PAYMENT_METHOD_NOT_FOUND');
    expect(CliError.fromApi({ success: false, errorCode: 1402, errorMessage: 'm', statusCode: 409, code: 'PAYMENT_METHOD_DISABLED' }).code).toBe('PAYMENT_METHOD_DISABLED');
  });

  it('UT-ERR-12d: D3 unknown string code falls back to HTTP-status mapping', () => {
    expect(CliError.fromApi({ success: false, errorCode: 0, errorMessage: 'm', statusCode: 404, code: 'SOME_UNKNOWN_CODE' }, { auth: 'api-key' }).code).toBe('RESOURCE_NOT_FOUND');
    // numeric string codes are not catalog keys → fall back too
    expect(CliError.fromApi({ success: false, errorCode: 1102, errorMessage: 'm', statusCode: 403, code: '1102' }, { auth: 'api-key' }).code).toBe('KEY_SCOPE_DENIED');
  });

  it('UT-ERR-12e: no string code → admin/token HTTP mapping unchanged (401 bearer/api-key)', () => {
    expect(CliError.fromApi({ success: false, errorCode: 1002, errorMessage: 'm', statusCode: 401 }, { auth: 'bearer' }).code).toBe('AUTH_SESSION_EXPIRED');
    expect(CliError.fromApi({ success: false, errorCode: 1002, errorMessage: 'm', statusCode: 401 }, { auth: 'api-key' }).code).toBe('KEY_INVALID');
  });

  it('UT-ERR-13: ValidationError -> PARAM_INVALID', () => {
    expect(toErrorEnvelope(new ValidationError('m')).error.code).toBe('PARAM_INVALID');
  });

  it('UT-ERR-14: ConfigError -> INTERNAL_ERROR', () => {
    expect(toErrorEnvelope(new ConfigError('m', 'p')).error.code).toBe('INTERNAL_ERROR');
  });

  it('UT-ERR-15: NetworkError -> UPSTREAM_ERROR', () => {
    expect(toErrorEnvelope(new NetworkError('u')).error.code).toBe('UPSTREAM_ERROR');
  });

  it('UT-ERR-16: UserCancelError -> CLIENT_ABORTED', () => {
    expect(toErrorEnvelope(new UserCancelError()).error.code).toBe('CLIENT_ABORTED');
  });

  it('UT-ERR-17: unknown throwable -> INTERNAL_ERROR', () => {
    expect(toErrorEnvelope(new Error('x')).error.code).toBe('INTERNAL_ERROR');
    expect(toErrorEnvelope('string').error.code).toBe('INTERNAL_ERROR');
    expect(toErrorEnvelope(null).error.code).toBe('INTERNAL_ERROR');
  });

  it('UT-ERR-18: return value is always ∈ ErrorCode union for any input', () => {
    const samples: unknown[] = [
      new UpgradeRequiredError('a', 'b', 'c'),
      new AuthError('m', 's'),
      CliError.fromApi({ success: false, errorCode: 1, errorMessage: 'm', statusCode: 401 }),
      new NetworkError('u'),
      new ValidationError('m'),
      new ConfigError('m', 'p'),
      new UserCancelError(),
      new Error('x'),
      'str',
      null,
      undefined,
      {},
    ];
    for (const s of samples) {
      expect(ALL_CODES).toContain(toErrorEnvelope(s).error.code);
    }
  });
});

describe('toErrorEnvelope structure (§8.2)', () => {
  it('UT-ERR-19: structure { error: { code, code_num, message, request_id? } }', () => {
    const env = toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1201, errorMessage: 'not found', statusCode: 404, requestId: 'req_123' }));
    expect(env.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(env.error.code_num).toBe(2001);
    expect(env.error.message).toBeTruthy();
    expect(env.error.request_id).toBe('req_123');
  });

  it('every code has a corresponding code_num (one-to-one binding)', () => {
    const env = toErrorEnvelope(new ValidationError('bad'));
    expect(env.error.code_num).toBe(CODE_NUM[env.error.code]);
  });

  it('local errors have no request_id field', () => {
    const env = toErrorEnvelope(new ValidationError('bad'));
    expect(env.error.request_id).toBeUndefined();
  });

  it('envelope no longer contains an http field', () => {
    const env = toErrorEnvelope(CliError.fromApi({ success: false, errorCode: 1, errorMessage: 'm', statusCode: 404 }));
    expect(env.error).not.toHaveProperty('http');
  });

  it('code always non-empty, message always non-empty, code_num is a number (including non-Error inputs)', () => {
    for (const s of [new Error(''), 'str', null, undefined, 42, {}]) {
      const env = toErrorEnvelope(s);
      expect(env.error.code).toBeTruthy();
      expect(env.error.message).toBeTruthy();
      expect(typeof env.error.code_num).toBe('number');
    }
  });
});

describe('provider pass-through and STABLE_MESSAGE isolation (§8.2 / Req 2.3, 4.4)', () => {
  it('UT-PROV-01: toErrorEnvelope with CliError that HAS upstream → envelope.error.upstream is present', () => {
    const upstream = { code: '400', message: 'Person count mismatch' };
    const err = new CliError('BOOKING_FAILED', 'The booking could not be completed. Please retry.', 422, 'req_1', upstream);
    const env = toErrorEnvelope(err);
    expect(env.error.upstream).toEqual(upstream);
  });

  it('UT-PROV-02: toErrorEnvelope with CliError that does NOT have upstream → envelope.error.upstream is undefined', () => {
    const err = new CliError('BOOKING_FAILED', 'The booking could not be completed. Please retry.', 422, 'req_2');
    const env = toErrorEnvelope(err);
    expect(env.error.upstream).toBeUndefined();
  });

  it('UT-PROV-03: toErrorEnvelope with non-CliError (plain Error) → envelope.error.upstream is absent', () => {
    const env = toErrorEnvelope(new Error('Something went wrong'));
    expect(env.error.upstream).toBeUndefined();
  });

  it('UT-PROV-04: CliError.fromApi with ApiError containing upstream → resulting CliError.upstream matches', () => {
    const upstream = { code: '403', message: 'Forbidden by provider' };
    const err = CliError.fromApi({
      success: false,
      errorCode: 1903,
      errorMessage: 'booking failed',
      statusCode: 422,
      code: 'BOOKING_FAILED',
      upstream,
    });
    expect(err.upstream).toEqual(upstream);
  });

  it('UT-PROV-05: CliError.fromApi with ApiError without upstream → resulting CliError.upstream is undefined', () => {
    const err = CliError.fromApi({
      success: false,
      errorCode: 1903,
      errorMessage: 'booking failed',
      statusCode: 422,
      code: 'BOOKING_FAILED',
    });
    expect(err.upstream).toBeUndefined();
  });

  it('UT-PROV-06a: toErrorEnvelope surfaces backend_message for INVALID_PAYMENT_METHOD (real card-decline reason)', () => {
    const err = CliError.fromApi(
      { success: false, errorCode: 1403, errorMessage: 'This card does not support this payment type.', statusCode: 400, code: 'INVALID_PAYMENT_METHOD' },
      { auth: 'api-key' },
    );
    const env = toErrorEnvelope(err);
    expect(env.error.code).toBe('INVALID_PAYMENT_METHOD');
    expect(env.error.message).toBe('The payment method is not available for this operation.');
    expect(env.error.backend_message).toBe('This card does not support this payment type.');
  });

  it('UT-PROV-06: top-level message is ALWAYS from STABLE_MESSAGE regardless of upstream presence', () => {
    const upstream = { code: '400', message: 'Person count mismatch' };
    const err = CliError.fromApi({
      success: false,
      errorCode: 1903,
      errorMessage: 'elife: Person count mismatch',
      statusCode: 422,
      code: 'BOOKING_FAILED',
      upstream,
    });
    const env = toErrorEnvelope(err);

    // Top-level message MUST be the stable message for BOOKING_FAILED
    expect(env.error.message).toBe('The booking could not be completed. Please retry.');
    // Top-level message MUST NOT be the upstream's message
    expect(env.error.message).not.toBe('Person count mismatch');
    expect(env.error.message).not.toContain('Person count mismatch');
    // Upstream message is isolated in its own field
    expect(env.error.upstream?.message).toBe('Person count mismatch');
  });
});

describe('NetworkError does not leak internal URL/path', () => {
  it('message does not contain the passed-in internal URL', () => {
    const env = toErrorEnvelope(new NetworkError('https://agent-test.everonet.com/api/admin/v1/auth/login'));
    expect(env.error.message).not.toContain('/api/admin/v1');
    expect(env.error.message).not.toContain('agent-test.everonet.com');
  });
});

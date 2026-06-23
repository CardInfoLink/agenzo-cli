import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from '../api-client/client.js';
import type { ApiError, UpstreamError } from '../api-client/client.js';

/**
 * ApiClient.request() error parsing — error_code + data.provider extraction.
 *
 * Validates: Requirements 4.3, 5.2, 5.4
 *
 * These tests verify that the ApiClient correctly:
 * - Prefers string `error_code` over numeric `code` for the ApiError.code field
 * - Extracts `data.upstream` into ApiError.upstream
 * - Handles all combinations of presence/absence gracefully
 */

// Mock the version module to avoid filesystem reads during tests
vi.mock('../version/version.js', () => ({
  getCurrentVersion: () => '0.1.1',
  isBelow: () => false,
  UPGRADE_COMMAND: 'npm install -g agenzo-admin-cli@latest',
}));

let client: ApiClient;

beforeEach(() => {
  client = new ApiClient({ baseUrl: 'https://api.test.com' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: mock global fetch to return a JSON error response. */
function mockFetchJsonError(
  body: Record<string, unknown>,
  status = 400,
): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Bad Request',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  }));
}

describe('ApiClient error_code + data.upstream parsing', () => {
  it('UT-AC-01: error_code present + data.upstream present → code = error_code, upstream populated', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'elife: Person count mismatch',
      data: {
        upstream: {
          code: '400',
          message: 'Person count mismatch',
        },
      },
      request_id: 'req_abc123',
    });

    const result = await client.get('/test', { type: 'none' });
    expect(result.success).toBe(false);

    const err = result as ApiError;
    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toEqual({
      code: '400',
      message: 'Person count mismatch',
    });
    expect(err.requestId).toBe('req_abc123');
    expect(err.errorCode).toBe(1903);
  });

  it('UT-AC-02: error_code present, NO data.upstream → code = error_code, upstream = undefined', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: null,
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-03: NO error_code, data.upstream present → code = numeric code string, upstream populated', async () => {
    mockFetchJsonError({
      code: '1903',
      message: 'elife: Person count mismatch',
      data: {
        upstream: {
          code: '400',
          message: 'Person count mismatch',
        },
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // Falls back to numeric code string since no error_code
    expect(err.code).toBe('1903');
    expect(err.upstream).toEqual({
      code: '400',
      message: 'Person count mismatch',
    });
  });

  it('UT-AC-04: neither error_code nor data.upstream → existing fallback behavior', async () => {
    mockFetchJsonError({
      code: '1903',
      message: 'Something went wrong',
      data: null,
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // Falls back to numeric code string
    expect(err.code).toBe('1903');
    expect(err.upstream).toBeUndefined();
    expect(err.errorCode).toBe(1903);
  });

  it('UT-AC-05: error_code takes priority over numeric code → ApiError.code = error_code string', async () => {
    mockFetchJsonError({
      code: '1901',
      error_code: 'VEHICLE_UNAVAILABLE',
      message: 'No vehicle available',
      data: {
        upstream: {
          code: '404',
          message: 'No vehicle found in area',
        },
      },
    }, 404);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // error_code wins over numeric code "1901"
    expect(err.code).toBe('VEHICLE_UNAVAILABLE');
    expect(err.errorCode).toBe(1901);
    expect(err.statusCode).toBe(404);
  });

  it('UT-AC-06: data.upstream is not an object (string) → upstream = undefined (graceful degradation)', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: {
        upstream: 'invalid',
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    // Non-object upstream is ignored gracefully
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-07: data.upstream is null → upstream = undefined', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: {
        upstream: null,
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-08: data.upstream is a number → upstream = undefined', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: {
        upstream: 42,
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-09: code "0000" with HTTP error status still treated as error', async () => {
    // Edge case: HTTP 500 but code = "0000" — response.ok is false so it's an error
    mockFetchJsonError({
      code: '0000',
      message: 'Internal error',
      data: null,
    }, 500);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // "0000" parses to 0, but code string is "0000" which is truthy
    expect(err.success).toBe(false);
    expect(err.statusCode).toBe(500);
  });

  it('UT-AC-10: error_code is empty string → falls back to numeric code', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: '',
      message: 'Some error',
      data: null,
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // Empty string is falsy, so errorCodeStr check fails → falls back to code
    expect(err.code).toBe('1903');
  });

  it('UT-AC-11: 5xx status with error_code + upstream → all fields correctly populated', async () => {
    mockFetchJsonError({
      code: '5101',
      error_code: 'UPSTREAM_ERROR',
      message: 'elife: timeout',
      data: {
        upstream: {
          code: 'NETWORK_ERROR',
          message: 'Connection timeout after 30s',
        },
      },
      request_id: 'req_xyz789',
    }, 502);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.statusCode).toBe(502);
    expect(err.errorCode).toBe(5101);
    expect(err.upstream).toEqual({
      code: 'NETWORK_ERROR',
      message: 'Connection timeout after 30s',
    });
    expect(err.requestId).toBe('req_xyz789');
  });
});

/** Helper: mock global fetch to return a JSON success response. */
function mockFetchJsonSuccess(
  body: Record<string, unknown>,
  status = 200,
): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  }));
}

describe('ApiClient success payload unwrapping', () => {
  it('UT-AC-11: data field present and null → payload is null (not the envelope)', async () => {
    // Regression: `data ?? responseBody` previously fell back to the whole
    // envelope when data was null (e.g. GET /accounts with no settlement
    // account), surfacing { code, message, data: null } as the payload and
    // breaking downstream null-checks. Must return null.
    mockFetchJsonSuccess({
      code: '0000',
      message: 'No settlement account found for this developer.',
      data: null,
    });

    const result = await client.get('/accounts', { type: 'none' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
      expect(result.message).toBe('No settlement account found for this developer.');
    }
  });

  it('UT-AC-12: data field present with object → payload is the unwrapped object', async () => {
    mockFetchJsonSuccess({
      code: '0000',
      message: 'ok',
      data: { id: 'acct_1', balance: 100 },
    });

    const result = await client.get('/accounts', { type: 'none' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: 'acct_1', balance: 100 });
    }
  });

  it('UT-AC-13: no data field (raw response) → payload is the whole body', async () => {
    mockFetchJsonSuccess({ status: 'CONSUMED', token: 'abc' });

    const result = await client.get('/raw', { type: 'none' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ status: 'CONSUMED', token: 'abc' });
    }
  });
});

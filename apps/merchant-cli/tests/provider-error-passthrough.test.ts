/**
 * Integration tests: upstream error passthrough (§8 controlled extension).
 *
 * Validates the full CliError.fromApi() → toErrorEnvelope() pipeline when the
 * backend returns the new `error_code` (D3 string routing key) and/or
 * `data.upstream` (upstream diagnostic transparency). These tests exercise the
 * REAL cli-core pipeline — no mocking of CliError/toErrorEnvelope internals.
 *
 * Requirements: 2.2, 5.3, 7.2, 7.3
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CliError,
  toErrorEnvelope,
  type ApiError,
} from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import type { ApiClient } from '@agenzo/cli-core';
import { registerQuoteCommand } from '../src/ride-elife/quote.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// Helpers
// ============================================================

/** Build a full ApiError with upstream error passthrough fields. */
function apiErrorWithUpstream(partial: Partial<ApiError>): ApiError {
  return {
    success: false,
    errorCode: 0,
    errorMessage: 'backend error',
    statusCode: 500,
    ...partial,
  };
}

type Mock = ReturnType<typeof mockApiClient>;

function quoteProgram(api: Mock) {
  const program = buildProgram();
  const ride = program.command('ride-elife');
  const deps = { apiClient: api as unknown as ApiClient };
  registerQuoteCommand(ride, deps);
  return program;
}

const BASE = ['node', 'cli', 'ride-elife'];

const quoteArgs = (extra: string[] = []) => [
  ...BASE, 'quote', '--api-key', 'k',
  '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
  '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
  '--pickup-time', 'now',
  ...extra,
];

// ============================================================
// TC-PROVIDER-01: error_code "QUOTE_EXPIRED" + data.upstream → D3 routing
// preserves QUOTE_EXPIRED; upstream passthrough; stable message
// ============================================================

describe('upstream error passthrough', () => {
  it('TC-PROVIDER-01: QUOTE_EXPIRED + upstream → code preserved, upstream passed through, stable message', async () => {
    // Simulate the ApiError that ApiClient would produce from a v3 envelope
    // containing error_code: "QUOTE_EXPIRED" + data.upstream
    const err = apiErrorWithUpstream({
      code: 'QUOTE_EXPIRED',
      statusCode: 410,
      requestId: 'req_qe_01',
      upstream: { code: '4100', message: 'Quote has expired' },
    });

    const cliError = CliError.fromApi(err, { auth: 'api-key' });

    // D3 routing: string code wins over HTTP 410 (which would map to generic)
    expect(cliError.code).toBe('QUOTE_EXPIRED');
    // Upstream is passed through intact
    expect(cliError.upstream).toEqual({
      code: '4100',
      message: 'Quote has expired',
    });
    // Stable message — NOT the eLife message
    expect(cliError.message).toBe('The quote has expired. Please request a new quote and retry.');
    expect(cliError.message).not.toContain('Quote has expired');

    // Full envelope verification
    const envelope = toErrorEnvelope(cliError);
    expect(envelope.error.code).toBe('QUOTE_EXPIRED');
    expect(envelope.error.code_num).toBe(4202);
    expect(envelope.error.message).toBe('The quote has expired. Please request a new quote and retry.');
    expect(envelope.error.request_id).toBe('req_qe_01');
    expect(envelope.error.upstream).toEqual({
      code: '4100',
      message: 'Quote has expired',
    });
  });

  it('TC-PROVIDER-01 (command integration): quote command throws CliError with upstream on API failure', async () => {
    // Mock apiClient.post to return an error response
    const api = mockApiClient();
    api.post.mockResolvedValueOnce({
      success: false,
      errorCode: 0,
      errorMessage: 'elife: Quote has expired',
      statusCode: 410,
      code: 'QUOTE_EXPIRED',
      requestId: 'req_cmd_01',
      upstream: { code: '4100', message: 'Quote has expired' },
    } satisfies ApiError);

    const program = quoteProgram(api);
    captureStdout();
    captureStderr();

    let caught: CliError | undefined;
    try {
      await program.parseAsync(quoteArgs());
    } catch (e) {
      caught = e as CliError;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect(caught!.code).toBe('QUOTE_EXPIRED');
    expect(caught!.upstream).toEqual({
      code: '4100',
      message: 'Quote has expired',
    });

    // Envelope stable message check
    const envelope = toErrorEnvelope(caught!);
    expect(envelope.error.message).toBe('The quote has expired. Please request a new quote and retry.');
  });

  // ============================================================
  // TC-PROVIDER-02: BOOKING_FAILED + upstream + HTTP 502
  // ============================================================

  it('TC-PROVIDER-02: BOOKING_FAILED + upstream → code preserved, upstream passed through, stable message', async () => {
    const err = apiErrorWithUpstream({
      code: 'BOOKING_FAILED',
      statusCode: 502,
      requestId: 'req_bf_01',
      upstream: { code: '500', message: 'Person count mismatch' },
    });

    const cliError = CliError.fromApi(err, { auth: 'api-key' });

    expect(cliError.code).toBe('BOOKING_FAILED');
    expect(cliError.upstream).toEqual({
      code: '500',
      message: 'Person count mismatch',
    });
    // Stable message — NOT the eLife error message
    expect(cliError.message).toBe('The booking could not be completed. Please retry.');
    expect(cliError.message).not.toContain('Person count mismatch');

    const envelope = toErrorEnvelope(cliError);
    expect(envelope.error.code).toBe('BOOKING_FAILED');
    expect(envelope.error.code_num).toBe(4203);
    expect(envelope.error.message).toBe('The booking could not be completed. Please retry.');
    expect(envelope.error.request_id).toBe('req_bf_01');
    expect(envelope.error.upstream).toEqual({
      code: '500',
      message: 'Person count mismatch',
    });
  });

  // ============================================================
  // TC-PROVIDER-03: No error_code (numeric "1905", HTTP 404) → HTTP fallback
  // to RESOURCE_NOT_FOUND; upstream still passed through
  // ============================================================

  it('TC-PROVIDER-03: no string error_code (numeric only) → HTTP fallback to RESOURCE_NOT_FOUND, upstream preserved', async () => {
    // When error_code is absent, the code field is a numeric string like "1905"
    // which is NOT a known CLI ErrorCode — so D3 routing falls through to HTTP
    // status mapping. Upstream is still passed through if present.
    const err = apiErrorWithUpstream({
      code: '1905', // numeric string — not in CLI catalog
      statusCode: 404,
      requestId: 'req_nf_01',
      upstream: { code: '404', message: 'Ride not found' },
    });

    const cliError = CliError.fromApi(err, { auth: 'api-key' });

    // HTTP 404 fallback → RESOURCE_NOT_FOUND
    expect(cliError.code).toBe('RESOURCE_NOT_FOUND');
    // Upstream is still passed through
    expect(cliError.upstream).toEqual({
      code: '404',
      message: 'Ride not found',
    });
    // Stable message for RESOURCE_NOT_FOUND
    expect(cliError.message).toBe('The resource was not found or does not belong to the current organization.');

    const envelope = toErrorEnvelope(cliError);
    expect(envelope.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(envelope.error.code_num).toBe(2001);
    expect(envelope.error.upstream).toEqual({
      code: '404',
      message: 'Ride not found',
    });
  });

  // ============================================================
  // TC-PROVIDER-04: No upstream data → CliError has no upstream field,
  // envelope omits upstream
  // ============================================================

  it('TC-PROVIDER-04: no upstream data → CliError has no upstream, envelope omits upstream field', async () => {
    const err = apiErrorWithUpstream({
      code: 'BOOKING_FAILED',
      statusCode: 502,
      requestId: 'req_np_01',
      // no upstream field
    });

    const cliError = CliError.fromApi(err, { auth: 'api-key' });

    expect(cliError.code).toBe('BOOKING_FAILED');
    expect(cliError.upstream).toBeUndefined();

    const envelope = toErrorEnvelope(cliError);
    expect(envelope.error.code).toBe('BOOKING_FAILED');
    expect(envelope.error.code_num).toBe(4203);
    expect(envelope.error.message).toBe('The booking could not be completed. Please retry.');
    expect(envelope.error.request_id).toBe('req_np_01');
    // upstream field must be ABSENT (not null, not undefined-as-a-key)
    expect(envelope.error).not.toHaveProperty('upstream');
  });
});

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { exitCodeFor } from '../exit/exit.js';
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
import type { UpstreamError } from '../api-client/client.js';

const ALL_CODES = Object.keys(CODE_NUM) as ErrorCode[];

const arbCliError: fc.Arbitrary<unknown> = fc.oneof(
  fc
    .record({
      errorCode: fc.integer({ min: 0, max: 9999 }),
      errorMessage: fc.string(),
      statusCode: fc.integer({ min: 100, max: 599 }),
      success: fc.constant(false as const),
    })
    .map((r) => CliError.fromApi(r)),
  fc
    .record({ message: fc.string(), suggestion: fc.string() })
    .map((r) => new AuthError(r.message, r.suggestion)),
  fc.string().map((u) => new NetworkError(u)),
  fc.string().map((m) => new ValidationError(m)),
  fc
    .record({ message: fc.string(), path: fc.string() })
    .map((r) => new ConfigError(r.message, r.path)),
  fc
    .record({ cur: fc.string(), min: fc.string(), cmd: fc.string() })
    .map((r) => new UpgradeRequiredError(r.cur, r.min, r.cmd)),
  fc.string().map((m) => new UserCancelError(m)),
);

const arbNonCliError: fc.Arbitrary<unknown> = fc.oneof(
  fc.string().map((m) => new Error(m)),
  fc.string(),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
  fc.array(fc.anything()),
  fc.anything(),
);

const arbError: fc.Arbitrary<unknown> = fc.oneof(arbCliError, arbNonCliError);

describe('mappers property-based', () => {
  it('PBT-01: exitCodeFor always returns a value in {1,2,3,4,5}', () => {
    fc.assert(
      fc.property(arbError, (e) => {
        expect([1, 2, 3, 4, 5]).toContain(exitCodeFor(e));
      }),
    );
  });

  it('PBT-03: toErrorEnvelope yields non-empty code and message', () => {
    fc.assert(
      fc.property(arbError, (e) => {
        const env = toErrorEnvelope(e);
        expect(ALL_CODES).toContain(env.error.code);
        expect(env.error.message.length).toBeGreaterThan(0);
      }),
    );
  });
});

/**
 * PBT-04: upstream isolation property.
 * Validates: Requirements 2.3, 2.4, 4.4, 7.1
 *
 * For any CliError (with or without upstream, random code/message):
 * - toErrorEnvelope(err).error.message is never empty
 * - If upstream is present it appears in the envelope; if absent it doesn't
 * - The top-level message never contains the upstream's message text (isolation)
 */
describe('upstream isolation property-based', () => {
  const arbUpstreamError: fc.Arbitrary<UpstreamError> = fc.record({
    code: fc.integer({ min: 1, max: 99999 }).map(String),
    message: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
  });

  const arbOptionalUpstream: fc.Arbitrary<UpstreamError | undefined> = fc.oneof(
    arbUpstreamError,
    fc.constant(undefined),
  );

  const arbCode: fc.Arbitrary<ErrorCode> = fc.constantFrom(...ALL_CODES);

  const arbCliErrorWithUpstream: fc.Arbitrary<CliError> = fc
    .record({
      code: arbCode,
      message: fc.string({ minLength: 1, maxLength: 100 }),
      statusCode: fc.integer({ min: 100, max: 599 }),
      requestId: fc.option(fc.string({ minLength: 5, maxLength: 20 }), { nil: undefined }),
      upstream: arbOptionalUpstream,
    })
    .map((r) => new CliError(r.code, r.message, r.statusCode, r.requestId, r.upstream));

  it('PBT-04: upstream isolation — present iff CliError carries it, top-level message never contains upstream message', () => {
    fc.assert(
      fc.property(arbCliErrorWithUpstream, (err) => {
        const env = toErrorEnvelope(err);

        // message is never empty
        expect(env.error.message.length).toBeGreaterThan(0);

        // upstream present iff CliError carries it
        if (err.upstream) {
          expect(env.error.upstream).toEqual(err.upstream);
        } else {
          expect(env.error.upstream).toBeUndefined();
        }

        // isolation: top-level message never contains upstream's message text
        // (only check when upstream message is non-trivial to avoid false positives
        //  with single-char matches against generic messages)
        if (err.upstream && err.upstream.message.length > 3) {
          expect(env.error.message).not.toContain(err.upstream.message);
        }
      }),
      { numRuns: 200 },
    );
  });
});

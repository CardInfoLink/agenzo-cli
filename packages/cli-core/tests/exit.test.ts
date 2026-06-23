import { describe, it, expect } from 'vitest';
import { exitCodeFor } from '../exit/exit.js';
import {
  CliError,
  AuthError,
  ConfigError,
  NetworkError,
  UpgradeRequiredError,
  UserCancelError,
  ValidationError,
} from '../errors/errors.js';

/**
 * Exit-code mapping (cli-design §8.6 / cli-standard §5.4).
 *   1 — business/param (incl. CLIENT_* business-ish) + unknown
 *   2 — UPGRADE_REQUIRED
 *   3 — AUTH_* / KEY_*
 *   4 — UPSTREAM_ERROR / INTERNAL_ERROR / RATE_LIMITED
 *   5 — CLIENT_ABORTED (user cancel)
 */
describe('exitCodeFor (§8.6)', () => {
  it('UT-EXIT-01: UpgradeRequiredError -> 2', () => {
    expect(exitCodeFor(new UpgradeRequiredError('0.1.0', '0.2.0', 'npm i -g x'))).toBe(2);
  });

  it('UT-EXIT-02: AuthError (not signed in, CLIENT_NOT_SIGNED_IN) -> 1', () => {
    expect(exitCodeFor(new AuthError('Not signed in', 'run login'))).toBe(1);
  });

  it('UT-EXIT-03: AuthError (session expired, AUTH_*) -> 3', () => {
    expect(exitCodeFor(new AuthError('Session expired', 'run login'))).toBe(3);
  });

  it('UT-EXIT-04: AuthError (login timeout, CLIENT_LOGIN_TIMEOUT) -> 1', () => {
    expect(exitCodeFor(new AuthError('Login timed out', 'retry'))).toBe(1);
  });

  it('UT-EXIT-05: ApiBusinessError 401 (AUTH_SESSION_EXPIRED) -> 3', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 1002, errorMessage: 'unauthorized', statusCode: 401 }))).toBe(3);
  });

  it('UT-EXIT-06: ApiBusinessError 403 (KEY_SCOPE_DENIED) -> 3', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 1102, errorMessage: 'scope denied', statusCode: 403 }))).toBe(3);
  });

  it('UT-EXIT-07: ApiBusinessError 404 -> 1', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 1201, errorMessage: 'not found', statusCode: 404 }))).toBe(1);
  });

  it('UT-EXIT-08: ApiBusinessError 409 -> 1', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 1004, errorMessage: 'conflict', statusCode: 409 }))).toBe(1);
  });

  it('UT-EXIT-09: ApiBusinessError 429 (RATE_LIMITED) -> 4', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 1429, errorMessage: 'rate limited', statusCode: 429 }))).toBe(4);
  });

  it('UT-EXIT-10: ApiBusinessError 422 (other 4xx) -> 1', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 2101, errorMessage: 'invalid', statusCode: 422 }))).toBe(1);
  });

  it('UT-EXIT-11: ApiBusinessError 500 (INTERNAL_ERROR) -> 4', () => {
    expect(exitCodeFor(CliError.fromApi({ success: false, errorCode: 5000, errorMessage: 'server error', statusCode: 500 }))).toBe(4);
  });

  it('UT-EXIT-12: ValidationError -> 1', () => {
    expect(exitCodeFor(new ValidationError('bad input'))).toBe(1);
  });

  it('UT-EXIT-13: ConfigError (INTERNAL_ERROR) -> 4', () => {
    expect(exitCodeFor(new ConfigError('corrupt', '/path/config.json'))).toBe(4);
  });

  it('UT-EXIT-14: NetworkError (UPSTREAM_ERROR) -> 4', () => {
    expect(exitCodeFor(new NetworkError('https://x', 30000))).toBe(4);
  });

  it('UT-EXIT-15: UserCancelError (CLIENT_ABORTED) -> 5', () => {
    expect(exitCodeFor(new UserCancelError())).toBe(5);
  });

  it('UT-EXIT-16: unknown Error -> 1', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(1);
  });

  it('UT-EXIT-17: non-Error input (string/null/undefined) -> 1', () => {
    expect(exitCodeFor('string error')).toBe(1);
    expect(exitCodeFor(null)).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it('UT-EXIT-18: return value is always ∈ {1,2,3,4,5}', () => {
    const samples: unknown[] = [
      new UpgradeRequiredError('a', 'b', 'c'),
      new AuthError('m', 's'),
      CliError.fromApi({ success: false, errorCode: 1, errorMessage: 'm', statusCode: 401 }),
      CliError.fromApi({ success: false, errorCode: 1, errorMessage: 'm', statusCode: 404 }),
      CliError.fromApi({ success: false, errorCode: 1, errorMessage: 'm', statusCode: 500 }),
      new NetworkError('u'),
      new ValidationError('m'),
      new ConfigError('m', 'p'),
      new UserCancelError(),
      new Error('x'),
      'str',
      null,
      undefined,
      42,
      {},
    ];
    for (const s of samples) {
      expect([1, 2, 3, 4, 5]).toContain(exitCodeFor(s));
    }
  });
});

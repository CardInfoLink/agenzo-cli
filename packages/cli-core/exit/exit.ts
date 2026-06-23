import { CliError } from '../errors/errors.js';

/**
 * Exit-code mapper (cli-design §8.6 / cli-standard §5.4).
 *
 * Maps any thrown error reaching the top-level handler to one of the CLI's
 * non-zero exit codes. Normal completion implies `0` and never consults this.
 *
 *   1 — business / param: PARAM_* / RESOURCE_* / BILLING_* / ACCOUNT_* /
 *       PAYMENT_ORDER_* / TOKEN_* / SERVICE_* / ride codes / CLIENT_* /
 *       NOT_IMPLEMENTED, and unknown errors
 *   2 — upgrade required: UPGRADE_REQUIRED
 *   3 — auth-fail / invalid-key: AUTH_* / KEY_*
 *   4 — network / 5xx: UPSTREAM_ERROR / INTERNAL_ERROR / RATE_LIMITED
 *   5 — user-cancel: CLIENT_ABORTED
 */
export function exitCodeFor(error: unknown): 1 | 2 | 3 | 4 | 5 {
  if (!(error instanceof CliError)) {
    return 1;
  }

  const code = error.code;

  if (code === 'UPGRADE_REQUIRED') {
    return 2;
  }

  if (code === 'CLIENT_ABORTED') {
    return 5;
  }

  if (code.startsWith('AUTH_') || code.startsWith('KEY_')) {
    return 3;
  }

  if (
    code === 'UPSTREAM_ERROR' ||
    code === 'INTERNAL_ERROR' ||
    code === 'RATE_LIMITED'
  ) {
    return 4;
  }

  return 1;
}

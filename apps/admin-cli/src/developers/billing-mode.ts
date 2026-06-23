import { ValidationError } from '@agenzo/cli-core';

/**
 * Developer billing modes (cli-design §4.2.2). Decides the funds-settlement
 * path when calling merchant fulfillment:
 *   - pay_per_call       → charge per transaction via payment-cli
 *   - monthly_settlement → deduct from a pre-funded settlement account
 */
export const VALID_BILLING_MODES = ['pay_per_call', 'monthly_settlement'] as const;
export type BillingMode = (typeof VALID_BILLING_MODES)[number];

/** Default when --billing-mode is not supplied. */
export const DEFAULT_BILLING_MODE: BillingMode = 'pay_per_call';

function isBillingMode(value: string): value is BillingMode {
  return (VALID_BILLING_MODES as readonly string[]).includes(value);
}

/**
 * Validate a `--billing-mode` flag value. Throws `ValidationError` on an
 * unknown value so the top-level handler maps it to PARAM_INVALID / exit 1.
 * Absent flag falls back to the default.
 */
export function resolveBillingMode(flag: string | undefined): BillingMode {
  if (flag === undefined) {
    return DEFAULT_BILLING_MODE;
  }
  const normalized = flag.trim().toLowerCase();
  if (!isBillingMode(normalized)) {
    throw new ValidationError(
      `Invalid --billing-mode: ${flag}. Allowed: ${VALID_BILLING_MODES.join(', ')}.`,
    );
  }
  return normalized;
}

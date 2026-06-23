import { checkbox } from '@inquirer/prompts';
import { ValidationError } from '@agenzo/cli-core';

/**
 * The CLI scopes an API Key may be granted. A scope controls which runtime
 * CLI(s) the key can call (cli-design §2.4.14):
 *   - token    → agenzo-token-cli (payment-methods / payment-tokens)
 *   - merchant → agenzo-merchant-cli (ride / services / ...)
 *   - payment  → agenzo-payment-cli (charges / refunds / ...)
 */
export const VALID_SCOPES = ['token', 'merchant', 'payment'] as const;
export type Scope = (typeof VALID_SCOPES)[number];

/** Default when neither --scope nor an interactive selection narrows it: all three. */
export const DEFAULT_SCOPES: Scope[] = ['token', 'merchant', 'payment'];

function isScope(value: string): value is Scope {
  return (VALID_SCOPES as readonly string[]).includes(value);
}

/**
 * Parse a comma-separated `--scope` value into a validated, de-duplicated,
 * canonically-ordered list. Throws `ValidationError` on any unknown token so
 * the top-level handler maps it to PARAM_INVALID / exit 1.
 */
export function parseScopeFlag(raw: string): Scope[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (parts.length === 0) {
    throw new ValidationError(
      `Invalid --scope: empty. Expected a comma-separated subset of ${VALID_SCOPES.join(', ')}.`,
    );
  }

  const invalid = parts.filter((p) => !isScope(p));
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid --scope value(s): ${invalid.join(', ')}. Allowed: ${VALID_SCOPES.join(', ')}.`,
    );
  }

  // De-duplicate while preserving the canonical token/merchant/payment order.
  return DEFAULT_SCOPES.filter((s) => parts.includes(s));
}

/**
 * Resolve the scope list for `keys create`.
 *
 * Precedence:
 *   1. `--scope` flag (validated via {@link parseScopeFlag}).
 *   2. `--yes` (non-interactive): default to all three scopes.
 *   3. Interactive multi-select (defaults all checked); empty selection falls
 *      back to all three.
 */
export async function resolveScopes(
  flag: string | undefined,
  nonInteractive: boolean,
): Promise<Scope[]> {
  if (flag !== undefined) {
    return parseScopeFlag(flag);
  }

  if (nonInteractive) {
    return DEFAULT_SCOPES;
  }

  const selected = await checkbox<Scope>({
    message: 'Select scopes (which CLIs this key may call):',
    choices: DEFAULT_SCOPES.map((s) => ({ name: s, value: s, checked: true })),
  });

  return selected.length > 0 ? selected : DEFAULT_SCOPES;
}

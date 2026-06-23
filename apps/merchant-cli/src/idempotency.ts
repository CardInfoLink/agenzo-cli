/**
 * Idempotency key resolution for write commands (`ride-elife book` / `cancel`)
 * — requirement 5.3 / §6.1, design Property 3.
 *
 * The error type is reused from `@agenzo/cli-core` (`IdempotencyKeyRequiredError`
 * → `PARAM_IDEMPOTENCY_KEY_REQUIRED`) so the merchant CLI does not re-define it.
 * The resolve/normalize logic stays in the app because it is merchant-domain
 * policy (per requirement 4.4): the §6.1 key format `[A-Za-z0-9_-]{1,128}`, the
 * `--yes`-missing hard error vs. interactive prompt branch, and the rule that
 * the key is forwarded verbatim as the `Idempotency-Key` HTTP header and is
 * never placed in the request body.
 *
 * The CLI NEVER auto-generates a key: under `--yes` a missing key is a hard
 * error thrown before any request is sent; otherwise the caller is prompted.
 */
import {
  CliError,
  IdempotencyKeyRequiredError,
  PromptEngine,
} from '@agenzo/cli-core';

/**
 * §6.1 idempotency key format: 1–128 characters drawn from `[A-Za-z0-9_-]`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Human-readable rule reused in validation messages and prompt feedback. */
export const IDEMPOTENCY_KEY_RULE = 'Use 1-128 characters from [A-Za-z0-9_-].';

/**
 * Validate + normalize a caller-supplied idempotency key. A malformed key maps
 * to `PARAM_INVALID` (catalog code, exit 1) — never silently corrected and
 * never auto-generated.
 */
export function normalizeIdempotencyKey(key: string): string {
  const trimmed = key.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new CliError(
      'PARAM_INVALID',
      `Invalid idempotency key: "${key}". ${IDEMPOTENCY_KEY_RULE}`,
    );
  }
  return trimmed;
}

/**
 * Resolve the idempotency key for a write operation (requirement 5.3). The CLI
 * never generates one:
 *   - supplied via `--idempotency-key` → validated + normalized;
 *   - absent under `--yes` → hard error (`PARAM_IDEMPOTENCY_KEY_REQUIRED`,
 *     reused from cli-core) thrown before any request is sent;
 *   - absent otherwise → collected interactively, then validated.
 *
 * The returned key is forwarded verbatim as the `Idempotency-Key` header by the
 * caller — it never enters the request body.
 */
export async function resolveIdempotencyKey(
  flagValue: string | undefined,
  opts: { yes: boolean; commandPath: string },
): Promise<string> {
  if (flagValue !== undefined) {
    return normalizeIdempotencyKey(flagValue);
  }
  if (opts.yes) {
    throw new IdempotencyKeyRequiredError(opts.commandPath);
  }
  const entered = await PromptEngine.resolveInput(undefined, {
    message: 'Idempotency key (unique per write, for safe retry):',
    validate: (v) => IDEMPOTENCY_KEY_PATTERN.test(v.trim()) || IDEMPOTENCY_KEY_RULE,
  });
  return normalizeIdempotencyKey(entered);
}

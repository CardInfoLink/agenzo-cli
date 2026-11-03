/**
 * Shared input/output helpers for the data-aisa command group.
 *
 * Mirrors the flight-flink / hotel-redaug conventions: required-flag validation
 * maps to `PARAM_INVALID` (catalog code, exit 1); JSON flags are parsed +
 * shape-checked before any request; results render via renderWithContext.
 *
 * This group is READ-ONLY and fully non-interactive by design: the only prompt
 * form allowed here is `resolveApiKey` (and even that returns immediately when
 * the flag is present, which is how the orchestrator always drives the CLI).
 */
import { CliError, Formatter, PromptEngine } from '@agenzo/cli-core';
import type { ApiClient, CommandResult } from '@agenzo/cli-core';
import { ConfigManager, resolveFormat, renderWithContext } from '@agenzo/cli-core';
import { IDEMPOTENCY_KEY_PATTERN, IDEMPOTENCY_KEY_RULE } from '../idempotency.js';

export type Deps = { apiClient: ApiClient };

/** Require a flag value; missing → PARAM_INVALID. */
export function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/** Parse a numeric flag; non-number → PARAM_INVALID. */
export function num(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isFinite(n)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return n;
}

/** Parse a JSON-object flag; non-JSON / non-object / array → PARAM_INVALID. Returned verbatim. */
export function jsonObject(raw: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('PARAM_INVALID', `--${flag} must be a JSON object.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validate an idempotency key and return it VERBATIM (R36): the raw flag value
 * itself must match the §6.1 format `[A-Za-z0-9_-]{1,128}`, and whatever passes
 * is forwarded byte-for-byte as the `Idempotency-Key` header.
 *
 * Deliberately not the write verbs' `normalizeIdempotencyKey`: that one trims
 * first, so ` k-1 ` would pass and go out as `k-1`. Here surrounding whitespace
 * is a malformed key → `PARAM_INVALID`, never a silent correction. The write
 * commands keep their own behavior untouched; only the pattern/rule constants
 * are shared so the format stays single-sourced.
 */
export function verbatimIdempotencyKey(raw: string, flag: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new CliError(
      'PARAM_INVALID',
      `Invalid --${flag}: "${raw}". ${IDEMPOTENCY_KEY_RULE}`,
    );
  }
  return raw;
}

/** Resolve the API key (flag or interactive password prompt). */
export function resolveApiKey(flag: string | undefined): Promise<string> {
  return PromptEngine.resolveInput(flag, { message: 'API Key:', type: 'password' });
}

/** Render a success result: JSON envelope in json mode, pretty text otherwise. */
export async function render<T>(
  data: T,
  format: string | undefined,
  text: (d: T) => string,
): Promise<void> {
  const resolved = resolveFormat(format);
  const result: CommandResult<T> = { data, text: () => text(data) };
  await renderWithContext(result, { format: resolved }, new ConfigManager());
}

/** Compact key/value renderer for arbitrary record data. */
export function kv(data: Record<string, unknown>): string {
  const lines: [string, string][] = Object.entries(data).map(([k, v]) => [
    k,
    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '-'),
  ]);
  return Formatter.keyValue(lines);
}

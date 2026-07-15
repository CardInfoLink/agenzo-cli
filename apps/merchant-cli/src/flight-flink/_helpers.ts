/**
 * Shared input/output helpers for the flight-flink command group.
 *
 * Mirrors the ride-elife / hotel-redaug conventions: required-flag validation
 * maps to `PARAM_INVALID` (catalog code, exit 1); JSON array flags are parsed +
 * shape-checked before any request; results render via renderWithContext.
 */
import { CliError, Formatter, PromptEngine } from '@agenzo/cli-core';
import type { ApiClient, CommandResult } from '@agenzo/cli-core';
import { ConfigManager, resolveFormat, renderWithContext } from '@agenzo/cli-core';

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

/** Parse a JSON-array flag; non-JSON / non-array → PARAM_INVALID. Returned verbatim. */
export function jsonArray(raw: string, flag: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('PARAM_INVALID', `--${flag} must be a JSON array.`);
  }
  if (!Array.isArray(parsed)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a JSON array.`);
  }
  return parsed;
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

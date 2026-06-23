import type { CommandResult } from '../types/commands.js';
import { Formatter, type StatusPrefix } from './formatter.js';

/**
 * Central output renderer.
 *
 * Single choke point that turns a {@link CommandResult} into stdout bytes,
 * switching between machine-readable JSON and a human-readable table view.
 * This is what lets command handlers stop calling `console.log` directly:
 * they build a `CommandResult` and hand it here.
 *
 * Contract (cli-standard §5.1/§5.2):
 * - stdout carries ONLY the business payload — a single JSON value
 *   (`--format json`) or human-readable text (`--format table`).
 * - logs, spinners, prompts, hints and progress lines belong on stderr and
 *   are NEVER written here.
 *
 * Recorded deviation from cli-standard §5.1: the default format is `table`
 * (not `json`), and the flag values are `json | table` (not `json | text`).
 */

/** The two supported output formats. */
export type OutputFormat = 'json' | 'table';

/** Options consumed by {@link render}. */
export interface RenderOptions {
  format: OutputFormat;
}

/** The default format used when nothing valid is supplied (deliberate deviation: `table`). */
const DEFAULT_FORMAT: OutputFormat = 'table';

/** Narrow an arbitrary string to a known {@link OutputFormat}. */
function isOutputFormat(value: string): value is OutputFormat {
  return value === 'json' || value === 'table';
}

/**
 * Resolve the active output format.
 *
 * Precedence: `--format` flag > `AGENZO_FORMAT` env var > default `table`.
 * Any invalid value falls back to the default. The result is always one of
 * `'json' | 'table'`.
 *
 * The `--format` flag is authoritative when provided: a provided-but-invalid
 * flag falls back to the default rather than deferring to the environment.
 */
export function resolveFormat(
  flag?: string,
  env: string | undefined = process.env.AGENZO_FORMAT,
): OutputFormat {
  // 1. --format flag is authoritative when provided.
  if (flag !== undefined) {
    return isOutputFormat(flag) ? flag : DEFAULT_FORMAT;
  }
  // 2. AGENZO_FORMAT environment value, when set to a valid format.
  if (env !== undefined && isOutputFormat(env)) {
    return env;
  }
  // 3. Default.
  return DEFAULT_FORMAT;
}

/**
 * Emit a successful command result to stdout in the chosen format.
 *
 * - `json`: writes `JSON.stringify(result.data, null, 2)` (the machine payload
 *   only — never the text-mode chrome).
 * - `table`: writes the lazy human presenter `result.text()`.
 *
 * Only the payload reaches stdout; status/progress lines must go to stderr by
 * the caller. A trailing newline is appended so the output pipes cleanly into
 * tools like `jq`.
 */
export function render<T>(result: CommandResult<T>, opts: RenderOptions): void {
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.text()}\n`);
}

/**
 * Emit a human-facing status line (✓ / ℹ / ⚠) to stderr — but ONLY in `table`
 * mode. In `json` mode the output is consumed by other agents/scripts, so any
 * decorative status text (even on stderr) is noise that can confuse parsing;
 * `json` mode therefore stays completely silent here. Errors are NOT routed
 * through this helper — they are owned by the top-level handler in index.ts.
 *
 * This is the single choke point for command success/progress notices, so the
 * `json`-silence rule is enforced in one place rather than scattered across
 * every handler.
 */
export function notify(
  format: OutputFormat,
  type: StatusPrefix,
  message: string,
): void {
  if (format === 'json') {
    return;
  }
  console.error(Formatter.status(type, message));
}

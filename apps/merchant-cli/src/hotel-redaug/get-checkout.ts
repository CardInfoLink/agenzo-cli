import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  createSpinner,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { GetCheckoutResponse } from '../types/hotel.js';
import {
  DEFAULT_CHECKOUT_WATCH_INTERVAL_SECONDS,
  DEFAULT_WATCH_TIMEOUT_SECONDS,
  resolveSeconds,
  watchCheckoutStatus,
} from './watch.js';
import { attachSchemaHelp, hotelGetCheckoutSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/get.ts and the sibling
// hotel-redaug/get.ts and quote.ts each define their own need) rather than
// pulled from a shared helpers file. `get-checkout` is read-only — no
// idempotency key.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 8.2 / design §4.4) — a catalog code (exit 1), mirroring the
 * `ride-elife` convention; `PARAM_REQUIRED` is intentionally not used (it is
 * not in the cli-core error catalog).
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

// ============================================================
// Output helper (table summary, non-watch path only)
// ============================================================

/**
 * Render a single check-out application as a key/value block for
 * `--format table`. `refund_status` is the application/refund status string
 * (pending | approved | rejected | refunded); `refund` is the final refund
 * (amount + currency), populated only once `refund_status` is approved or
 * refunded. `refund.amount` is a DECIMAL currency unit (NOT cents) — printed
 * verbatim.
 */
function formatGetCheckout(data: GetCheckoutResponse): string {
  const lines: [string, string][] = [
    ['Task order code', String(data.task_order_code ?? '-')],
    ['Refund status', String(data.refund_status ?? '-')],
  ];
  if (data.refund !== undefined && data.refund !== null) {
    lines.push(['Refund amount', String(data.refund.amount)]);
    lines.push(['Refund currency', String(data.refund.currency)]);
  }

  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug get-checkout` — poll a check-out application by task order code
 * (§ get-checkout schema). Read-only (no idempotency key); path built from
 * `--task-order-code` only.
 *
 * Two modes (branching mirrors `hotel-redaug/get.ts`):
 *   - Non-`--watch`: a single `GET /hotel/checkout/<task_order_code>` →
 *     `CommandResult` + `renderWithContext` (json carries the profile/endpoint
 *     envelope). Renders `task_order_code`, `refund_status`, and `refund`
 *     (amount + currency, decimal units).
 *   - `--watch`: hands off to `watchCheckoutStatus` (watch.ts), which polls
 *     until a terminal refund status (`refund_status ∈ {approved, rejected,
 *     refunded}`) or timeout, writing each result as ONE NDJSON line on stdout.
 *     The watch stream is NOT wrapped in the profile/endpoint envelope (it is a
 *     line stream); on timeout the final line is `{ watch_status: 'timeout',
 *     ... }`.
 *
 * Required-flag validation (`--task-order-code`) throws `PARAM_INVALID` BEFORE
 * any request. Named `registerHotelGetCheckoutCommand` to avoid clashing with
 * the `ride-elife` registrars when both are imported into `index.ts`.
 */
export function registerHotelGetCheckoutCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('get-checkout')
    .description('Retrieve a check-out application status and refund outcome (repeatable for polling)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option(
      '--task-order-code <code>',
      'Check-out application id returned by `hotel-redaug checkout`',
    )
    .option('--watch', 'Poll until a terminal status, emitting one NDJSON line per update')
    .option(
      '--watch-interval <seconds>',
      `Seconds between polls when --watch is set (default ${DEFAULT_CHECKOUT_WATCH_INTERVAL_SECONDS})`,
    )
    .option(
      '--watch-timeout <seconds>',
      `Max seconds to poll before giving up (default ${DEFAULT_WATCH_TIMEOUT_SECONDS})`,
    );

  attachSchemaHelp(cmd, hotelGetCheckoutSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });
    // Required-flag validation BEFORE any request → PARAM_INVALID. The path is
    // built from --task-order-code only.
    const taskOrderCode = need(opts.taskOrderCode as string | undefined, 'task-order-code');

    // --watch: NDJSON line stream (no profile/endpoint envelope). The stream
    // itself is the progress, so no spinner/notify is emitted.
    if (opts.watch) {
      await watchCheckoutStatus(deps.apiClient, apiKey, taskOrderCode, {
        intervalSeconds: resolveSeconds(
          opts.watchInterval as string | undefined,
          DEFAULT_CHECKOUT_WATCH_INTERVAL_SECONDS,
        ),
        timeoutSeconds: resolveSeconds(
          opts.watchTimeout as string | undefined,
          DEFAULT_WATCH_TIMEOUT_SECONDS,
        ),
      });
      return;
    }

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner =
      format === 'json' ? null : createSpinner('Fetching check-out application status...');

    const result = await deps.apiClient.get<GetCheckoutResponse>(
      `/hotel/checkout/${encodeURIComponent(taskOrderCode)}`,
      { type: 'api-key', key: apiKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<GetCheckoutResponse> = {
      data,
      text: () => formatGetCheckout(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

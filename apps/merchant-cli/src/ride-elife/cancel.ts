import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
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
import type { CancelResponse } from '../types/api.js';
import { attachSchemaHelp, cancelSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (ride-domain — stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 3.3 / §4.4.1.3 cancel schema) — a catalog code (exit 1),
 * mirroring the sibling quote/book/get commands' convention.
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render a cancelled ride as a key/value block for `--format table`. Amounts
 * are decimal currency units (NOT cents) — printed verbatim. `cancellation`
 * may be null when the backend reports no fee/reversal breakdown.
 */
function formatCancel(data: CancelResponse): string {
  const lines: [string, string][] = [
    ['Ride ID', String(data.ride_id ?? '-')],
    ['Status', String(data.ride_stat ?? '-')],
  ];
  if (data.cancellation) {
    const c = data.cancellation;
    lines.push(['Cancellation fee', `${c.cancellation_fee} ${c.currency}`]);
    lines.push(['Reversal amount', `${c.reversal_amount} ${c.currency}`]);
  }
  if (data.refund_amount !== undefined && data.refund_amount !== null) {
    lines.push(['Refund amount', String(data.refund_amount)]);
  }

  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife cancel` — cancel a ride order by id (§4.4.1.3 cancel schema).
 * Write op (W/Y).
 *
 * `POST /ride/<order-id>/cancel` with NO request body, `X-Api-Key` auth, and
 * the `Idempotency-Key` header (key forwarded verbatim, never in the body).
 * Cancelling may incur a fee, so the non-`--yes` path MUST confirm before the
 * write; `--yes` skips the confirmation. A missing `--idempotency-key` under
 * `--yes` throws `PARAM_IDEMPOTENCY_KEY_REQUIRED` before any request is sent;
 * non-`--yes` prompts for it. Declining the confirmation maps to
 * `CLIENT_ABORTED` (exit 5) via the top-level envelope. Renders
 * `CancelResponse` via `renderWithContext` (json carries the profile/endpoint
 * envelope); the progress line goes to stderr via `notify` and stays silent in
 * json mode.
 */
export function registerCancelCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('cancel')
    .description('Cancel a ride order by id (may incur a cancellation fee)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Ride order id to cancel (the ride_id returned by book)')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, cancelSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Required input throws PARAM_INVALID before any request is sent (mirrors
    // the sibling get/book commands).
    const orderId = need(opts.orderId as string | undefined, 'order-id');

    // Confirm before the write unless --yes. Cancelling may incur a fee, so the
    // prompt warns explicitly (requirement 3.3). The warning/prompt go to
    // stderr; declining maps to CLIENT_ABORTED (exit 5) via the top-level
    // envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Cancel ride ${orderId}? This may incur a fee.`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Cancellation aborted by user.');
      }
    }

    // Idempotency key (requirement 5.3): resolved before the request. Under
    // --yes a missing key is a hard error and no request is sent. The key is
    // sent as a header, never in the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'ride-elife cancel',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Cancelling ride...');

    // POST /ride/<id>/cancel carries NO body — only the Idempotency-Key header.
    const result = await deps.apiClient.post<CancelResponse>(
      `/ride/${encodeURIComponent(orderId)}/cancel`,
      { type: 'api-key', key: apiKey },
      undefined,
      { 'Idempotency-Key': idempotencyKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<CancelResponse> = {
      data,
      text: () => formatCancel(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

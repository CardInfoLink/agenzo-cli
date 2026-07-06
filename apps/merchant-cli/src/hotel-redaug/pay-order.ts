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
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, hotelPayOrderSchema } from '../verb-schema.js';
import {
  ndjsonWriteLine,
  realSleep,
  resolveSeconds,
} from './watch.js';

// ============================================================
// Response type
// ============================================================

export interface PayHotelOrderResponse {
  order_id: string;
  settlement_path?: string;
  /** Always "PAID" for orders created under the current architecture. */
  status?: string;
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

// ============================================================
// Constants
// ============================================================

/** Default polling interval for --watch mode (seconds). */
export const DEFAULT_PAY_WATCH_INTERVAL_SECONDS = 5;
/** Default polling timeout for --watch mode (seconds). */
export const DEFAULT_PAY_WATCH_TIMEOUT_SECONDS = 300;

// ============================================================
// Output helper
// ============================================================

function formatPayOrder(data: PayHotelOrderResponse): string {
  const lines: [string, string][] = [
    ['Order ID', String(data.order_id ?? '-')],
    ['Order status', String(data.status ?? '-')],
  ];
  if (data.settlement_path) lines.push(['Settlement path', String(data.settlement_path)]);
  if (data.amount != null && data.currency) {
    lines.push(['Amount', `${data.amount} ${data.currency}`]);
  }

  return Formatter.keyValue(lines);
}

// ============================================================
// Watch (polling) logic for pay-order
// ============================================================

/**
 * Terminal predicate for pay-order watch: PAID means done.
 * Any error response triggers exit 1 outside the loop (thrown as CliError).
 */
function isPaymentTerminal(record: unknown): boolean {
  const status = (record as { status?: unknown }).status;
  return status === 'PAID';
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug pay-order` — trigger supplier confirmation (payOrder) for an
 * order that was already created and paid via `create-order`.
 *
 * `create-order` handles all payment logic (authorize + capture from the
 * developer's account/card); `pay-order` takes only `--order-id` and notifies
 * the supplier to confirm/issue the booking. There is no separate payment
 * gateway interaction for the caller at this step.
 *
 * - `--order-id` (required): the order to confirm with the supplier.
 * - `--idempotency-key` (required): forwarded as header.
 * - `--watch` / `--watch-interval` / `--watch-timeout`: polling mode
 *   (retained for backward compatibility).
 *
 * On success: exit 0, print the confirmation result.
 * On business error: exit 1, error code to stderr.
 */
export function registerHotelPayOrderCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('pay-order')
    .description('Trigger supplier confirmation for a paid hotel order (upstream payOrder)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Order ID to pay (from create-order response)')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    )
    .option('--watch', 'Poll until PAID or timeout (NDJSON output)', false)
    .option(
      '--watch-interval <seconds>',
      'Seconds between polls when --watch is set',
      String(DEFAULT_PAY_WATCH_INTERVAL_SECONDS),
    )
    .option(
      '--watch-timeout <seconds>',
      'Max seconds to poll before giving up',
      String(DEFAULT_PAY_WATCH_TIMEOUT_SECONDS),
    );

  attachSchemaHelp(cmd, hotelPayOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Required: --order-id
    const orderId = opts.orderId as string | undefined;
    if (orderId === undefined) {
      throw new CliError('PARAM_INVALID', 'Missing required --order-id.');
    }

    // Idempotency key resolution
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'hotel-redaug pay-order',
    });

    // Watch mode params
    const watchEnabled = Boolean(opts.watch);
    const watchInterval = resolveSeconds(opts.watchInterval as string, DEFAULT_PAY_WATCH_INTERVAL_SECONDS);
    const watchTimeout = resolveSeconds(opts.watchTimeout as string, DEFAULT_PAY_WATCH_TIMEOUT_SECONDS);

    // Pay-order sends no body params — it triggers supplier confirmation for an
    // order that was already paid in create-order.
    const body: Record<string, unknown> = {};

    // Confirm before the write unless --yes. Although this step does not move
    // money (that happened in create-order), it commits the booking with the
    // supplier. The prompt goes to stderr; declining maps to CLIENT_ABORTED
    // (exit 5) via the top-level envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Confirm hotel order ${orderId} with the supplier? (Payment was already settled in create-order; this triggers supplier confirmation.)`,
        default: true,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Confirmation aborted by user.');
      }
    }

    const path = `/hotel/${encodeURIComponent(orderId)}/pay`;
    const headers = { 'Idempotency-Key': idempotencyKey };
    const auth = { type: 'api-key' as const, key: apiKey };

    if (!watchEnabled) {
      // Single-shot mode
      const spinner = format === 'json' ? null : createSpinner('Paying hotel order...');

      const result = await deps.apiClient.post<PayHotelOrderResponse>(
        path,
        auth,
        body,
        headers,
      );

      spinner?.stop();

      if (!result.success) {
        throw CliError.fromApi(result, { auth: 'api-key' });
      }

      const data = result.data;
      const configManager = new ConfigManager();
      const commandResult: CommandResult<PayHotelOrderResponse> = {
        data,
        text: () => formatPayOrder(data),
      };

      await renderWithContext(commandResult, { format }, configManager);
    } else {
      // Watch mode: retained for backward compatibility. Since create-order
      // now settles inline, the order is already PAID (or in a terminal
      // non-PAID state) by the time pay-order can be called — there is no
      // longer a transient "not yet paid" state to poll through, so this
      // loop returns on its first successful iteration in practice. Any
      // business error (e.g. a genuinely terminal non-PAID state) is
      // non-retryable and exits immediately.
      const deadline = Date.now() + watchTimeout * 1000;
      let lastRecord: unknown = null;

      for (;;) {
        const result = await deps.apiClient.post<PayHotelOrderResponse>(
          path,
          auth,
          body,
          headers,
        );

        if (result.success) {
          const data = result.data;
          lastRecord = data;
          ndjsonWriteLine(data);

          if (isPaymentTerminal(data)) {
            return;
          }
        } else {
          // Non-retryable business error → exit 1
          throw CliError.fromApi(result, { auth: 'api-key' });
        }

        // Check timeout
        if (Date.now() + watchInterval * 1000 >= deadline) {
          const timeoutLine = {
            watch_status: 'timeout',
            message: `Polling stopped after ${watchTimeout}s without reaching PAID status.`,
            last_status: lastRecord,
          };
          ndjsonWriteLine(timeoutLine);
          return;
        }

        await realSleep(watchInterval * 1000);
      }
    }
  });
}

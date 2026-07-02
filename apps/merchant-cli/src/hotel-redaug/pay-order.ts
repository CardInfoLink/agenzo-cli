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
  order_status: string;
  settlement_path?: string;
  pay_status?: string;
  total_amount?: number;
  currency?: string;
  billing_entry_id?: string;
  merchant_trans_id?: string;
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
    ['Order status', String(data.order_status ?? '-')],
  ];
  if (data.settlement_path) lines.push(['Settlement path', String(data.settlement_path)]);
  if (data.pay_status) lines.push(['Pay status', String(data.pay_status)]);
  if (data.total_amount != null && data.currency) {
    lines.push(['Amount', `${data.total_amount} ${data.currency}`]);
  }
  if (data.billing_entry_id) lines.push(['Billing entry', String(data.billing_entry_id)]);
  if (data.merchant_trans_id) lines.push(['Merchant trans ID', String(data.merchant_trans_id)]);

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
  const status = (record as { order_status?: unknown }).order_status;
  return status === 'PAID';
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug pay-order` — settle an existing hotel order created via
 * `create-order`. Calls `POST /hotel/{order_id}/pay` with `Idempotency-Key`
 * header and optional `PayHotelOrderRequest` body.
 *
 * - `--order-id` (required): the order to pay.
 * - `--merchant-trans-id` (optional): normally OMITTED. The settlement path is
 *   decided server-side by billing_mode, not by this flag. For Active_Payment
 *   (现结) the EVO merchantTransID is the order_id (the user pays via EVO under
 *   the order_id), so the platform derives it; if supplied it must equal the
 *   order_id, else MERCHANT_TRANS_ID_INVALID.
 * - `--idempotency-key` (required): forwarded as header.
 * - `--watch` / `--watch-interval` / `--watch-timeout`: polling mode that
 *   retries on PAYMENT_NOT_COMPLETED until PAID or timeout.
 *
 * This is the step that actually moves money, so the non-`--yes` path MUST
 * confirm (naming the billing path — monthly settlement vs. Active Payment)
 * before the write; `--yes` skips it. A declined confirm maps to
 * `CLIENT_ABORTED` (exit 5). Applies to both the single-shot and `--watch`
 * paths (the confirm happens once, before polling begins).
 *
 * On success: exit 0, print settlement result.
 * On business error: exit 1, error code to stderr.
 * Watch mode: NDJSON output per poll iteration.
 */
export function registerHotelPayOrderCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('pay-order')
    .description('Settle an existing hotel order (path decided by billing_mode: monthly_settlement or Active_Payment/现结)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Order ID to pay (from create-order response)')
    .option('--merchant-trans-id <id>', 'Optional; if supplied MUST equal --order-id. Normally omit — for Active_Payment the platform verifies the EVO payment made under the order_id')
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

    // Optional: --merchant-trans-id. Normally omitted — for Active_Payment the
    // platform derives the EVO merchantTransID from the order_id (the user pays
    // via EVO under the order_id). If supplied it must equal the order_id.
    const merchantTransId = opts.merchantTransId as string | undefined;

    // Idempotency key resolution
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'hotel-redaug pay-order',
    });

    // Watch mode params
    const watchEnabled = Boolean(opts.watch);
    const watchInterval = resolveSeconds(opts.watchInterval as string, DEFAULT_PAY_WATCH_INTERVAL_SECONDS);
    const watchTimeout = resolveSeconds(opts.watchTimeout as string, DEFAULT_PAY_WATCH_TIMEOUT_SECONDS);

    // Build request body
    const body: Record<string, unknown> = {};
    if (merchantTransId !== undefined) {
      body.merchant_trans_id = merchantTransId;
    }

    // Confirm before the write unless --yes. This is the step that actually
    // moves money (settlement account debit, or EVO verification), so the
    // prompt is explicit about which billing path applies. The prompt goes to
    // stderr; declining maps to CLIENT_ABORTED (exit 5) via the top-level
    // envelope.
    if (!isYes) {
      const billingPath = merchantTransId !== undefined
        ? `Active Payment (verifying EVO transaction ${merchantTransId})`
        : 'monthly settlement (deducting from your settlement account)';
      const confirmed = await confirm({
        message: `Settle hotel order ${orderId} via ${billingPath}? This will move money.`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Payment aborted by user.');
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
      // Watch mode: poll until PAID or timeout, output NDJSON per iteration
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
          // Business error — check if it's PAYMENT_NOT_COMPLETED (retryable in watch)
          const errorCode = (result as any).code ?? (result as any).errorCode;
          const errorCodeStr = String(errorCode);

          if (errorCodeStr === 'PAYMENT_NOT_COMPLETED' || errorCodeStr === '1933') {
            // Retryable: output the error as NDJSON line and continue
            const errorLine = {
              watch_status: 'pending',
              error_code: errorCodeStr === '1933' ? 'PAYMENT_NOT_COMPLETED' : errorCodeStr,
              message: (result as any).errorMessage ?? 'Payment not yet completed',
            };
            lastRecord = errorLine;
            ndjsonWriteLine(errorLine);
          } else {
            // Non-retryable business error → exit 1
            throw CliError.fromApi(result, { auth: 'api-key' });
          }
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

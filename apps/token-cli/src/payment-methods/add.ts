import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  IdempotencyKeyRequiredError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult, OutputFormat } from '@agenzo/cli-core';
import type { PaymentMethod } from '../types/api.js';
import { collectPaymentMethodParams } from './prompts.js';

// ============================================================
// Constants
// ============================================================

/** Polling interval for 3DS verification status (milliseconds). */
const POLL_INTERVAL_MS = 3000;

/** Maximum polling duration for 3DS verification (15 minutes in ms). */
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-methods add` — add a payment method and run 3DS verification (§3.4.0.1).
 *
 * Flags: --api-key, --type (default card), --email, --card-number, --expiry (MMYY), --cvv.
 * Missing values collected via PromptEngine.collectPaymentMethodParams.
 *
 * POST /payment-methods/create (X-Api-Key + Idempotency-Key).
 * If status==='PENDING', polls GET /payment-methods/verification/status until
 * ACTIVE (success), FAILED, or 15-minute timeout.
 *
 * Output (§3.4.0.1):
 *   ✓ Payment method created  + keyValue + ℹ Complete 3DS verification...
 *   ✓ Payment method activated + details (on 3DS success)
 *   ✗ 3DS verification failed (on 3DS failure)
 *   Timeout hint message (on 15-min timeout)
 */
export function registerAddCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('add')
    .description('Add a payment method (with 3DS verification)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--type <type>', 'Payment method type (default: card)', 'card')
    .option('--email <email>', 'Email for 3DS verification')
    .option('--card-number <number>', 'Card number')
    .option('--expiry <mmyy>', 'Expiry date (MMYY format)')
    .option('--cvv <cvv>', 'Card CVV')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    // --- Resolve API key ---
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // --- Resolve payment method type ---
    const type = (opts.type as string) || 'card';

    // --- Collect card params via PromptEngine ---
    const flags: Record<string, string | undefined> = {
      email: opts.email as string | undefined,
      cardNumber: opts.cardNumber as string | undefined,
      expiry: opts.expiry as string | undefined,
      cvv: opts.cvv as string | undefined,
    };
    const params = await collectPaymentMethodParams(type, flags);

    // --- Idempotency key (required for write, Requirement 6.3) ---
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payment-methods add');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    // --- POST /payment-methods/create ---
    const result = await deps.apiClient.post<PaymentMethod>(
      '/payment-methods/create',
      { type: 'api-key', key: apiKey },
      params,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const pm = result.data;

    // --- Output: created state ---
    notify(format, 'success', 'Payment method created');

    const createdResult: CommandResult<PaymentMethod> = {
      data: pm,
      text: () => {
        const lines: [string, string][] = [
          ['ID', pm.id],
          ['Type', pm.type],
          ['Status', pm.status],
        ];
        if (pm.brand) lines.push(['Brand', pm.brand]);
        if (pm.first6) lines.push(['First 6', pm.first6]);
        if (pm.last4) lines.push(['Last 4', pm.last4]);
        return Formatter.keyValue(lines);
      },
    };

    const configManager = new ConfigManager();
    await renderWithContext(createdResult, { format }, configManager);

    // Hint about 3DS (after keyValue output)
    notify(format, 'info', 'Complete 3DS verification via email to activate');

    // --- 3DS polling (only for type=card and PENDING status) ---
    if (type === 'card' && pm.status === 'PENDING') {
      const finalStatus = await poll3dsVerification(
        deps.apiClient,
        apiKey,
        pm.id,
        format,
      );

      if (finalStatus === 'ACTIVE') {
        // Fetch the updated payment method for full details
        const getResult = await deps.apiClient.get<PaymentMethod>(
          `/payment-methods/${pm.id}`,
          { type: 'api-key', key: apiKey },
        );

        if (getResult.success) {
          const activatedPm = getResult.data;
          notify(format, 'success', 'Payment method activated');

          const activatedResult: CommandResult<PaymentMethod> = {
            data: activatedPm,
            text: () => {
              const lines: [string, string][] = [
                ['ID', activatedPm.id],
                ['Type', activatedPm.type],
                ['Status', activatedPm.status],
              ];
              if (activatedPm.brand) lines.push(['Brand', activatedPm.brand]);
              if (activatedPm.first6) lines.push(['First 6', activatedPm.first6]);
              if (activatedPm.last4) lines.push(['Last 4', activatedPm.last4]);
              return Formatter.keyValue(lines);
            },
          };

          await renderWithContext(activatedResult, { format }, configManager);
        } else {
          // 3DS already reported ACTIVE, but the follow-up detail GET failed.
          // Emit a degraded terminal state from what we already know (the
          // create response + known-ACTIVE status) rather than exiting silently.
          notify(format, 'success', 'Payment method activated');

          const degraded: PaymentMethod = { ...pm, status: 'ACTIVE' };
          const degradedResult: CommandResult<PaymentMethod> = {
            data: degraded,
            text: () => {
              const lines: [string, string][] = [
                ['ID', degraded.id],
                ['Type', degraded.type],
                ['Status', degraded.status],
              ];
              if (degraded.brand) lines.push(['Brand', degraded.brand]);
              if (degraded.first6) lines.push(['First 6', degraded.first6]);
              if (degraded.last4) lines.push(['Last 4', degraded.last4]);
              return Formatter.keyValue(lines);
            },
          };

          await renderWithContext(degradedResult, { format }, configManager);
        }
      } else if (finalStatus === 'FAILED') {
        notify(format, 'error', '3DS verification failed');
      } else if (finalStatus === 'TIMEOUT') {
        notify(
          format,
          'info',
          `Verification timed out (15 min). Check status with: agenzo-token-cli payment-methods get ${pm.id} --api-key <your_key>`,
        );
      }
    }
  });
}

// ============================================================
// 3DS Polling Helper
// ============================================================

/**
 * Poll GET /payment-methods/verification/status?payment_method_id=<id> every
 * 3000ms until ACTIVE, FAILED, or 15-minute timeout.
 *
 * Returns the terminal status: 'ACTIVE' | 'FAILED' | 'TIMEOUT'.
 */
async function poll3dsVerification(
  apiClient: ApiClient,
  apiKey: string,
  paymentMethodId: string,
  format: OutputFormat,
): Promise<'ACTIVE' | 'FAILED' | 'TIMEOUT'> {
  const startTime = Date.now();

  notify(format, 'info', 'Waiting for 3DS verification...');

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const result = await apiClient.get<{ status: string }>(
      '/payment-methods/verification/status',
      { type: 'api-key', key: apiKey },
      { payment_method_id: paymentMethodId },
    );

    if (result.success) {
      const status = result.data.status;
      if (status === 'ACTIVE') {
        return 'ACTIVE';
      }
      if (status === 'FAILED') {
        return 'FAILED';
      }
      // Still PENDING — continue polling
    }
    // On API error during polling, continue trying (transient failures)
  }

  return 'TIMEOUT';
}

/** Simple async sleep utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

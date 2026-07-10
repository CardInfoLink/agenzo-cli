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
import type { CommandResult } from '@agenzo/cli-core';

type PayDeps = { apiClient: ApiClient };

/** Server ChargeResult payload (amounts in integer cents). */
interface ChargeResult {
  charge_no: string;
  payment_brand: string;
  amount_cents: number;
  fee_cents: number;
  total_cents: number;
  currency: string;
  pay_status: string;
  merchant_trans_id?: string;
  evo_trans_id?: string;
  result_code?: string | null;
  result_message?: string | null;
}

/** Format integer cents to a display string (1250 -> "12.50"). */
function formatCents(cents: number | undefined): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * `payments capture` — charge a previously created payment token.
 *
 * Amount / currency / fee are taken from the token (set when it was created),
 * so this verb does NOT accept --amount / --currency. Branch is chosen by
 * `--payment-brand` (evo default | unionpay). Requires `--idempotency-key`
 * (never auto-generated). API key and Idempotency-Key are sent as headers.
 *
 * Registered under the `payments` command group (see index.ts) so the full
 * invocation is `agenzo-payment-cli payments capture` — matching the
 * orchestrator's three-segment tool name `payment__payments__capture`.
 */
export function registerPayCommand(parent: Command, deps: PayDeps): void {
  const cmd = parent
    .command('capture')
    .description('Capture (charge) a previously created payment token')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--payment-token-id <id>', 'Payment token ID to charge (ptk_...)')
    .option(
      '--payment-brand <brand>',
      'Payment brand override (optional; auto-detected from token). "evo" or "unionpay".',
    )
    .option('--description <text>', 'Optional payment description')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header (required; not auto-generated)',
    );

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const paymentBrand = opts.paymentBrand
      ? String(opts.paymentBrand).toLowerCase()
      : undefined;
    if (paymentBrand && paymentBrand !== 'evo' && paymentBrand !== 'unionpay') {
      throw new CliError(
        'PARAM_INVALID',
        `Unknown --payment-brand "${opts.paymentBrand}". Expected "evo" or "unionpay".`,
      );
    }

    // --- Resolve API key ---
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // --- Resolve payment token id ---
    const paymentTokenId = await PromptEngine.resolveInput(
      opts.paymentTokenId as string | undefined,
      {
        message: 'Payment token ID (ptk_...):',
        validate: (v) => v.trim().length > 0 || 'Payment token ID is required',
      },
    );

    // --- Idempotency key (required for write; never auto-generated) ---
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payments capture');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per charge, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const body: Record<string, unknown> = {
      payment_token_id: paymentTokenId,
    };
    if (paymentBrand) {
      body.payment_brand = paymentBrand;
    }
    if (opts.description) {
      body.description = opts.description as string;
    }

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.apiClient.post<ChargeResult>(
      '/pay',
      { type: 'api-key', key: apiKey },
      body,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const charge = result.data;
    notify(format, 'success', 'Payment charged');

    const commandResult: CommandResult<ChargeResult> = {
      data: charge,
      text: () =>
        Formatter.keyValue([
          ['Charge No', charge.charge_no],
          ['Status', charge.pay_status],
          ['Brand', charge.payment_brand],
          ['Amount', `${formatCents(charge.amount_cents)} ${charge.currency}`],
          ['Fee', `${formatCents(charge.fee_cents)} ${charge.currency}`],
          ['Total', `${formatCents(charge.total_cents)} ${charge.currency}`],
          ['Merchant Trans ID', charge.merchant_trans_id ?? '-'],
          ['EVO Trans ID', charge.evo_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

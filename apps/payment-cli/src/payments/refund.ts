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

type RefundDeps = { apiClient: ApiClient };

/** Server RefundResult payload (amounts in integer cents). */
interface RefundResult {
  refund_no: string;
  charge_no: string;
  refunded_cents: number;
  currency: string;
  status: string; // success | failed | pending
  merchant_trans_id?: string;
  evo_trans_id?: string;
}

function formatCents(cents: number | undefined): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * `payments refund` — refund a prior standalone charge.
 *
 * Locate the original charge by `--charge-no` (preferred) or `--payment-token-id`; the platform
 * routes the refund to the original funding source (brand-agnostic — UnionPay / EVO both refund
 * by the captured merchant_trans_id). `--amount-cents` is optional: omit for a full refund, or
 * pass a value <= the original total for a partial refund. Requires `--idempotency-key` (never
 * auto-generated). API key and Idempotency-Key are sent as headers.
 *
 * Registered under the `payments` command group → `agenzo-payment-cli payments refund`
 * (orchestrator tool `payment__payments__refund`).
 */
export function registerRefundCommand(parent: Command, deps: RefundDeps): void {
  const cmd = parent
    .command('refund')
    .description('Refund a prior standalone charge (full or partial)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--charge-no <no>', 'Original charge number to refund (chg_...); preferred locator')
    .option('--payment-token-id <id>', 'Alternatively, refund the latest successful charge of this token (ptk_...)')
    .option('--amount-cents <cents>', 'Partial refund amount in integer cents (omit for full refund)')
    .option('--reason <text>', 'Optional refund reason')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header (required; not auto-generated)',
    );

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // --- Locator: charge_no (preferred) or payment_token_id (at least one) ---
    let chargeNo = opts.chargeNo as string | undefined;
    const paymentTokenId = opts.paymentTokenId as string | undefined;
    if (!chargeNo && !paymentTokenId) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing locator: provide --charge-no or --payment-token-id for payments refund.',
        );
      }
      chargeNo = await PromptEngine.resolveInput(undefined, {
        message: 'Charge number to refund (chg_...):',
        validate: (v) => v.trim().length > 0 || 'A charge number (or --payment-token-id) is required',
      });
    }

    // --- amount_cents (optional, positive integer when provided) ---
    let amountCents: number | undefined;
    const amountRaw = opts.amountCents as string | undefined;
    if (amountRaw !== undefined && amountRaw !== '') {
      amountCents = Number(amountRaw);
      if (!Number.isInteger(amountCents) || amountCents < 1) {
        throw new CliError(
          'PARAM_INVALID',
          `--amount-cents must be a positive integer (cents) when provided. Got "${amountRaw}".`,
        );
      }
    }

    // --- Idempotency key (required for write; never auto-generated) ---
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payments refund');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per refund, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const body: Record<string, unknown> = {};
    if (chargeNo) body.charge_no = chargeNo;
    if (paymentTokenId) body.payment_token_id = paymentTokenId;
    if (amountCents !== undefined) body.amount_cents = amountCents;
    if (opts.reason) body.reason = opts.reason as string;

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.apiClient.post<RefundResult>(
      '/refund',
      { type: 'api-key', key: apiKey },
      body,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const refund = result.data;
    notify(format, 'success', 'Refund processed');

    const commandResult: CommandResult<RefundResult> = {
      data: refund,
      text: () =>
        Formatter.keyValue([
          ['Refund No', refund.refund_no],
          ['Charge No', refund.charge_no || '-'],
          ['Status', refund.status],
          ['Refunded', `${formatCents(refund.refunded_cents)} ${refund.currency}`],
          ['Merchant Trans ID', refund.merchant_trans_id ?? '-'],
          ['EVO Trans ID', refund.evo_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

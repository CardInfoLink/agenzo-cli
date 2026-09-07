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

type ChargeCardDeps = { apiClient: ApiClient };

/** Server CardChargeResult payload (amounts in integer cents). */
interface CardChargeResult {
  charge_no: string;
  status: string; // requires_action | pending | success | failed
  amount_cents: number;
  currency: string;
  payment_brand: string;
  three_ds_url?: string;
  merchant_trans_id?: string;
  evo_trans_id?: string;
}

/** Format integer cents to a display string (1250 -> "12.50"). */
function formatCents(cents: number | undefined): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * `payments charge-card` — authorize a standalone charge on a bound EVO/Mastercard card.
 *
 * EVO cards have no payment token (cannot use `payments capture`/`/pay`); this authorizes
 * an amount on the card via the platform's EVO preauth rail. EVO forces cardholder 3DS, so
 * the usual outcome is `status="requires_action"` with a `three_ds_url` — open it, let the
 * cardholder complete 3DS, then call `payments charge-card-resume --charge-no <chg_...>` to
 * confirm and capture. Requires `--idempotency-key` (never auto-generated). API key and
 * Idempotency-Key are sent as headers.
 *
 * Registered under the `payments` command group so the full invocation is
 * `agenzo-payment-cli payments charge-card` — matching the orchestrator tool name
 * `payment__payments__charge-card`.
 */
export function registerChargeCardCommand(parent: Command, deps: ChargeCardDeps): void {
  const cmd = parent
    .command('charge-card')
    .description('Authorize a standalone charge on a bound EVO/Mastercard card (3DS two-phase)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--payment-method-id <id>', 'Bound card to charge (must be an EVO-rail Mastercard)')
    .option('--amount-cents <cents>', 'Charge amount in integer cents (e.g. 4433 = 44.33)')
    .option('--currency <code>', 'ISO 4217 currency (default: USD)')
    .option('--cardholder-phone <phone>', 'Cardholder phone in E.164 (required by EVO 3DS)')
    .option('--member-id <id>', 'End-user attribution: restrict card selection to this member')
    .option('--description <text>', 'Optional charge description')
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

    // --- payment_method_id (required) ---
    let paymentMethodId = opts.paymentMethodId as string | undefined;
    if (!paymentMethodId) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --payment-method-id for payments charge-card (required in --yes mode).',
        );
      }
      paymentMethodId = await PromptEngine.resolveInput(undefined, {
        message: 'Payment method ID (bound EVO card):',
        validate: (v) => v.trim().length > 0 || 'Payment method ID is required',
      });
    }

    // --- amount_cents (required, positive integer) ---
    const amountRaw = opts.amountCents as string | undefined;
    if (!amountRaw) {
      throw new CliError('PARAM_INVALID', 'Missing required --amount-cents for payments charge-card.');
    }
    const amountCents = Number(amountRaw);
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new CliError(
        'PARAM_INVALID',
        `--amount-cents must be a positive integer (cents). Got "${amountRaw}".`,
      );
    }

    // --- cardholder_phone (required by EVO 3DS) ---
    let cardholderPhone = opts.cardholderPhone as string | undefined;
    if (!cardholderPhone) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --cardholder-phone for payments charge-card (EVO 3DS requires it).',
        );
      }
      cardholderPhone = await PromptEngine.resolveInput(undefined, {
        message: 'Cardholder phone (E.164, e.g. +14155551234):',
        validate: (v) => v.trim().length > 0 || 'Cardholder phone is required',
      });
    }

    // --- Idempotency key (required for write; never auto-generated) ---
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payments charge-card');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per charge, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const body: Record<string, unknown> = {
      payment_method_id: paymentMethodId,
      amount_cents: amountCents,
      currency: (opts.currency as string | undefined) || 'USD',
      cardholder_phone: cardholderPhone,
    };
    if (opts.memberId) {
      body.member_id = opts.memberId as string;
    }
    if (opts.description) {
      body.description = opts.description as string;
    }

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.apiClient.post<CardChargeResult>(
      '/charge/card',
      { type: 'api-key', key: apiKey },
      body,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const charge = result.data;
    notify(format, 'success', 'Card charge authorized');

    const commandResult: CommandResult<CardChargeResult> = {
      data: charge,
      text: () =>
        Formatter.keyValue([
          ['Charge No', charge.charge_no],
          ['Status', charge.status],
          ['Brand', charge.payment_brand],
          ['Amount', `${formatCents(charge.amount_cents)} ${charge.currency}`],
          ['3DS URL', charge.three_ds_url || '-'],
          ['Merchant Trans ID', charge.merchant_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

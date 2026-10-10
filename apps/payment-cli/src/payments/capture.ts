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
  pay_status: string; // success | failed | pending | requires_action
  three_ds_url?: string;
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
      '--member <member_id>',
      'End-user member id this token belongs to; forwarded to the request body as member_id ' +
        '(optional). The platform only verifies token ownership when it is present, so ' +
        'programmatic callers (the agent orchestrator) inject it from the authenticated ' +
        'session — never from the model. Omit it and no ownership check is performed.',
    )
    .option(
      '--payment-brand <brand>',
      'Payment brand override (optional; auto-detected from token). "evo" or "unionpay".',
    )
    .option('--description <text>', 'Optional payment description')
    .option(
      '--authenticate',
      'Require cardholder passkey/3DS on this charge (EVO/Mastercard network token only). ' +
        'When the gateway needs authentication the response returns pay_status=requires_action ' +
        '+ three_ds_url; open it, complete the passkey, then run `payments capture-resume`.',
    )
    .option(
      '--return-url <url>',
      'Return URL for the passkey/3DS redirect (used with --authenticate; server falls back to its configured EVO 3DS return URL).',
    )
    .option(
      '--cardholder-phone <phone>',
      'Cardholder phone in E.164 (e.g. +14155551234). Required by FIDOPage when --authenticate is set.',
    )
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

    // --- Resolve payment token id (required; --yes with no value is a hard error) ---
    let paymentTokenId = opts.paymentTokenId as string | undefined;
    if (!paymentTokenId) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --payment-token-id for payments capture (required in --yes mode).',
        );
      }
      paymentTokenId = await PromptEngine.resolveInput(undefined, {
        message: 'Payment token ID (ptk_...):',
        validate: (v) => v.trim().length > 0 || 'Payment token ID is required',
      });
    }

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
    // Ownership scoping (same body field as `payments charge-card`): the platform only
    // verifies that the token belongs to this member when member_id is present — absent it,
    // anyone holding a token id could charge someone else's card. Non-empty values only;
    // blank is omitted entirely rather than sent as "".
    const member = ((opts.member as string | undefined) ?? '').trim();
    if (member) {
      body.member_id = member;
    }
    if (paymentBrand) {
      body.payment_brand = paymentBrand;
    }
    if (opts.description) {
      body.description = opts.description as string;
    }
    if (opts.authenticate) {
      body.authenticate = true;
    }
    if (opts.returnUrl) {
      body.return_url = opts.returnUrl as string;
    }
    if (opts.cardholderPhone) {
      body.cardholder_phone = opts.cardholderPhone as string;
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
    notify(
      format,
      'success',
      charge.pay_status === 'requires_action'
        ? 'Authentication required — open the 3DS/passkey URL, then run capture-resume'
        : 'Payment charged',
    );

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
          ...(charge.three_ds_url ? [['3DS URL', charge.three_ds_url] as [string, string]] : []),
          ['Merchant Trans ID', charge.merchant_trans_id ?? '-'],
          ['EVO Trans ID', charge.evo_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

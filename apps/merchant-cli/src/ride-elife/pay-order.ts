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
import type { PayRideOrderResponse } from '../types/api.js';
import { attachSchemaHelp, ridePayOrderSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (ride-domain — body assembly stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (a catalog code, exit 1), mirroring the sibling `create-order` / `book`
 * commands.
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/**
 * Enforce the exactly-one payment-credential rule (requirement 11.5). The two-step
 * pay MUST carry exactly one of `--payment-token-id` (network-token direct charge,
 * the main path) or `--payment-method-id` (EVO bound-card fallback). Both missing
 * and both present are rejected LOCALLY with a distinguishable `PARAM_INVALID`
 * error BEFORE any request is sent, so `Ride_Service.pay` is never called with an
 * ambiguous credential set. The two branches carry distinct messages so the
 * offending condition (neither vs. both) is itself distinguishable.
 */
function assertExactlyOneCredential(
  paymentTokenId: string | undefined,
  paymentMethodId: string | undefined,
): void {
  const hasToken = paymentTokenId !== undefined;
  const hasMethod = paymentMethodId !== undefined;
  if (!hasToken && !hasMethod) {
    throw new CliError(
      'PARAM_INVALID',
      'Invalid payment credential options: provide exactly one of --payment-token-id ' +
        '(network-token direct charge) or --payment-method-id (EVO bound card). Neither was given.',
    );
  }
  if (hasToken && hasMethod) {
    throw new CliError(
      'PARAM_INVALID',
      'Invalid payment credential options: --payment-token-id and --payment-method-id are ' +
        'mutually exclusive — provide exactly one, not both.',
    );
  }
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render the settled order as a key/value block for `--format table`. Amounts
 * are decimal currency units (NOT cents) — printed verbatim. The order reference
 * is resolved from `order_ref` when present, else `order_id` (both carry the
 * authoritative rio_… value). Status / payment status are echoed from the
 * response (a successful settlement returns PAID / SETTLED — requirement 11.4).
 */
function formatPayOrder(data: PayRideOrderResponse): string {
  const orderRef = String(data.order_ref ?? data.order_id ?? '-');
  const lines: [string, string][] = [
    ['Order ref', orderRef],
    ['Status', String(data.status ?? '-')],
    ['Payment status', String(data.payment_status ?? '-')],
  ];
  if (data.ride_id !== undefined) lines.push(['Ride ID', String(data.ride_id)]);
  if (data.payment_channel) lines.push(['Payment channel', String(data.payment_channel)]);
  if (data.price) {
    lines.push(['Amount', `${data.price.amount} ${data.price.currency}`]);
    if (data.price.quote_id) lines.push(['Quote ID', String(data.price.quote_id)]);
  }

  return [
    Formatter.keyValue(lines),
    Formatter.status(
      'success',
      `Order ${orderRef} settled — ${data.status ?? 'PAID'} / ${data.payment_status ?? 'SETTLED'}.`,
    ),
  ].join('\n\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife pay-order` — settle a locked ride order by `--order-id` (the
 * second step of the two-step network-token direct-charge flow;
 * ride-network-token-direct-charge R11.2/R11.4/R11.5). Mirrors
 * `flight-flink pay-order` / `hotel-redaug pay-order`: funds move HERE (not in
 * create-order), and on success the order is pushed AWAITING_PAYMENT → PAID /
 * payment_status=SETTLED.
 *
 * Exactly one payment credential is required (requirement 11.5, mutual
 * exclusion): `--payment-token-id` (network-token direct charge — the main
 * path, `charge(order_id=order_ref)` triggers strict order↔token binding) OR
 * `--payment-method-id` (EVO bound-card fallback). Both missing and both present
 * are rejected LOCALLY with a distinguishable `PARAM_INVALID` error before any
 * request is sent — `Ride_Service.pay` is never called with an ambiguous
 * credential set. `--authorized-merchant-trans-id` resumes an EVO 3DS challenge.
 *
 * `POST /ride/pay` with `X-Api-Key` auth + the `Idempotency-Key` header (key
 * forwarded verbatim, never in the body). The order reference and payment
 * credentials travel in the body. Since this step actually charges the card,
 * the non-`--yes` path confirms before the write; `--yes` skips it and a missing
 * `--idempotency-key` under `--yes` throws `PARAM_IDEMPOTENCY_KEY_REQUIRED`
 * before any request is sent. A declined confirm maps to `CLIENT_ABORTED`.
 */
export function registerRidePayOrderCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('pay-order')
    .description('Settle a locked ride order by --order-id (charges the card, creates the ride)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'The order_ref (rio_…) from create-order to settle')
    .option(
      '--payment-token-id <id>',
      'Network-token id (unionpay/visa direct-charge path). Exactly one of ' +
        '--payment-token-id / --payment-method-id is required.',
    )
    .option(
      '--payment-method-id <id>',
      'Bound-card id to charge via EVO preauth+capture (fallback path). Exactly one of ' +
        '--payment-token-id / --payment-method-id is required.',
    )
    .option(
      '--authorized-merchant-trans-id <id>',
      'Resume a 3DS challenge: merchant trans id of an already-authorised preauth',
    )
    .option(
      '--evo-explicit',
      '[方案 B/R16] Explicit opt-in to settle this pay_per_call ride via the EVO bound-card fallback rail. Set ONLY when the user explicitly chose EVO; forwarded to the pay body as evo_explicit=true. Without it, a pay_per_call settlement lacking --payment-token-id is hard-gated server-side.',
    )
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, ridePayOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    // Validate the target order + payment credentials FIRST — before resolving
    // the API key or prompting — so an invalid credential set fails fast and
    // never triggers a request to Ride_Service.pay (requirement 11.5).
    const orderId = need(opts.orderId as string | undefined, 'order-id');
    const paymentTokenId = opts.paymentTokenId as string | undefined;
    const paymentMethodId = opts.paymentMethodId as string | undefined;
    assertExactlyOneCredential(paymentTokenId, paymentMethodId);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build request body. The order reference and the (validated) exactly-one
    // payment credential travel in the body; the amount/currency are NOT sent —
    // the platform settles at the order's locked authoritative amount and the
    // token's minted amount, never a caller-supplied value (requirement 2.6).
    const body: Record<string, unknown> = { order_id: orderId };
    if (paymentTokenId !== undefined) body.payment_token_id = paymentTokenId;
    if (paymentMethodId !== undefined) body.payment_method_id = paymentMethodId;
    if (opts.authorizedMerchantTransId !== undefined) {
      body.authorized_merchant_trans_id = opts.authorizedMerchantTransId as string;
    }
    // 方案 B/R16 显式 EVO 选择信号：仅在置位时透传 evo_explicit=true；缺省则不发（平台默认 false）。
    if (opts.evoExplicit) body.evo_explicit = true;

    // Confirm before the write unless --yes. This step actually moves money
    // (network-token direct charge or EVO preauth+capture) and creates the ride
    // upstream. The prompt goes to stderr; declining maps to CLIENT_ABORTED
    // (exit 5) via the top-level envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Settle ride order ${orderId}? This charges the card and creates the ride (AWAITING_PAYMENT → PAID).`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Payment aborted by user.');
      }
    }

    // Idempotency key: resolved before the request. Under --yes a missing key is
    // a hard error and no request is sent. The key is sent as a header, never in
    // the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'ride-elife pay-order',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Settling ride order...');

    const result = await deps.apiClient.post<PayRideOrderResponse>(
      '/ride/pay',
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<PayRideOrderResponse> = {
      data,
      text: () => formatPayOrder(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

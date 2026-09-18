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

// ============================================================
// Constants / helpers
// ============================================================

/**
 * Visa direct (VTS) network tokens carry the order amount as **integer cents**
 * via the nested `visa.order_amount_cents` field — NOT a decimal string and
 * NOT with any unit conversion (contrast UnionPay's `unionpay_amount`, a plain
 * decimal string). The value is passed through byte-for-byte
 * (amount_cents=12345 → order_amount_cents=12345).
 *
 * Valid inputs are positive integers in the inclusive range [1, 99,999,999]
 * (R2.5): a bare run of digits with no sign, no decimal point, no thousands
 * separators and no scientific notation. Anything else — decimals like "12.5",
 * non-numeric like "abc", zero, or out-of-range — is rejected up-front with
 * `CliError('PARAM_INVALID')` so no minting request is ever sent for an invalid
 * amount.
 */
const INTEGER_CENTS_RE = /^\d+$/;
const ORDER_AMOUNT_CENTS_MIN = 1;
const ORDER_AMOUNT_CENTS_MAX = 99_999_999;

/** True when `amountStr` is a positive integer in [1, 99,999,999] cents. */
function isValidOrderAmountCents(amountStr: string): boolean {
  const trimmed = amountStr.trim();
  if (!INTEGER_CENTS_RE.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= ORDER_AMOUNT_CENTS_MIN && n <= ORDER_AMOUNT_CENTS_MAX;
}

/**
 * Parse a validated `--order-amount-cents` string into the integer the request
 * body requires — pass-through, no unit conversion (amount_cents=12345 →
 * order_amount_cents=12345). Callers MUST run `isValidOrderAmountCents` first.
 */
function parseOrderAmountCents(amountStr: string): number {
  return Number(amountStr.trim());
}

/** Format a Visa network token PENDING response for output (payment_url for the passkey page). */
function formatVisaPendingToken(data: Record<string, unknown>): string {
  const lines: [string, string][] = [
    ['Payment Token ID', String(data.id || '')],
    ['Type', 'Network Token'],
    ['Status', String(data.status || 'PENDING')],
  ];
  if (data.payment_brand) {
    lines.push(['Payment Brand', String(data.payment_brand)]);
  }
  return Formatter.keyValue(lines);
}

/** Format an ACTIVE Visa network token for output (DPAN + cryptogram now present). */
function formatVisaActiveToken(data: Record<string, unknown>): string {
  const nt = (data.network_token as Record<string, unknown> | undefined) ?? {};
  const lines: [string, string][] = [
    ['Payment Token ID', String(data.id || '')],
    ['Type', 'Network Token'],
    ['Status', String(data.status || 'ACTIVE')],
    ['Payment Brand', String(data.payment_brand || 'visa')],
    ['Network Token (DPAN)', String(nt.value || '')],
    ['Cryptogram (TAVV)', String(nt.cryptogram || '')],
    ['Expiry', String(nt.expiry_date || '')],
  ];
  if (data.instruction_id) {
    lines.push(['Instruction ID', String(data.instruction_id)]);
  }
  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-tokens visa-create` — start Visa direct (VTS) network-token creation,
 * print the payment_url, then poll until the token reaches a terminal status.
 *
 * It POSTs /payment-tokens/create with a `type=network_token` body carrying the
 * nested Visa DTO (`visa.order_amount_cents` in integer cents), prints the
 * returned `payment_url` (+ token id + status, PENDING at this point — the
 * platform's self-hosted page hosts the Visa FIDO passkey iframe), then polls
 * GET /payment-tokens/{id} every 5s for up to 180s. The token's ACTIVE is
 * written synchronously by the browser's later `visa/payment/resolve` request
 * (no webhook), so re-reading the token is the only way to observe activation;
 * the 180s cap is longer than UnionPay's 60s because completion is driven by a
 * human passkey action, not a backend event. On timeout the token stays PENDING
 * and the follow-up `payment-tokens get <id>` hint is printed. Polling runs
 * unconditionally (also under --yes): the internal orchestrator wants the
 * terminal state, not just the URL.
 *
 * Not advertised in the SKILL/README and does NOT register attachSchemaHelp
 * (mirrors unionpay-create / dropin-create).
 */
export function registerVisaCreateCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('visa-create')
    .description('Start a Visa network-token creation, print the payment_url, then poll until ACTIVE/FAILED (up to 180s)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--payment-method-id <id>', 'Visa payment method ID to use (required)')
    .option(
      '--order-amount-cents <cents>',
      'Order amount in integer cents, e.g. 12345 for $123.45 (required)',
    )
    .option('--currency <currency>', 'Currency code, e.g. USD (optional)')
    .option('--order-description <text>', 'Order description (optional)')
    .option('--merchant-order-id <id>', 'Merchant order id (optional)')
    .option(
      '--external-transaction-id <id>',
      'Order id to bind this token to; forwarded to the request body as external_transaction_id (optional)',
    )
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    let paymentMethodId = opts.paymentMethodId as string | undefined;
    if (!paymentMethodId) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --payment-method-id for visa-create (required in --yes mode)',
        );
      }
      paymentMethodId = await PromptEngine.resolveInput(undefined, {
        message: 'Payment method id:',
        validate: (v) => v.trim().length > 0 || 'Payment method id is required',
      });
    }

    let orderAmountCentsStr = opts.orderAmountCents as string | undefined;
    if (!orderAmountCentsStr) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --order-amount-cents for visa-create (required in --yes mode)',
        );
      }
      orderAmountCentsStr = await PromptEngine.resolveInput(undefined, {
        message: 'Order amount in integer cents (e.g. 12345 for $123.45):',
        validate: (v) =>
          isValidOrderAmountCents(v) ||
          'Amount must be a positive integer in cents (1..99,999,999), no decimals',
      });
    }
    // Strict integer/range validation (R2.5): reject decimals / non-numeric /
    // zero / out-of-range up-front so no minting request is sent for a bad
    // amount.
    if (!isValidOrderAmountCents(orderAmountCentsStr)) {
      throw new CliError(
        'PARAM_INVALID',
        `Invalid --order-amount-cents "${orderAmountCentsStr}". Expected a positive integer in cents (1..99,999,999), no decimals.`,
      );
    }
    const orderAmountCents = parseOrderAmountCents(orderAmountCentsStr);

    const currency = (opts.currency as string | undefined)?.trim() || undefined;
    const orderDescription = (opts.orderDescription as string | undefined) || undefined;
    const merchantOrderId = (opts.merchantOrderId as string | undefined) || undefined;
    // Bind the token to a merchant order (order_id) when supplied. Maps to the
    // platform create_token request body field `external_transaction_id`
    // (distinct from the generic `payment-tokens create --external-tx-id`,
    // which maps to `external_tx_id`). Sits at the TOP level of the body — the
    // nested `visa.merchant_order_id` is a separate, Visa-specific field.
    const externalTransactionId = (opts.externalTransactionId as string | undefined)?.trim() || undefined;

    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payment-tokens visa-create');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const body: Record<string, unknown> = {
      type: 'network_token',
      payment_method_id: paymentMethodId,
      ...(currency ? { currency } : {}),
      ...(externalTransactionId ? { external_transaction_id: externalTransactionId } : {}),
      visa: {
        order_amount_cents: orderAmountCents,
        ...(orderDescription ? { order_description: orderDescription } : {}),
        ...(merchantOrderId ? { merchant_order_id: merchantOrderId } : {}),
      },
    };

    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/payment-tokens/create',
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const tokenData = result.data;
    if (!tokenData.type) {
      tokenData.type = 'network_token';
    }

    // status === 'PENDING' guard (R6.6 — the new guard relative to
    // unionpay-create): a freshly minted Visa network token is expected to
    // come back PENDING (the platform's self-hosted page hosts the FIDO
    // passkey iframe; completing the assertion later flips it to ACTIVE with
    // no webhook). Any other status means minting was not initiated as
    // expected, so fail with a non-zero exit BEFORE rendering — this runs
    // ahead of notify/renderWithContext so the payment_url is never printed
    // for a token that isn't awaiting passkey verification.
    const tokenStatus = String(tokenData.status ?? '');
    if (tokenStatus !== 'PENDING') {
      throw new CliError(
        'RESOURCE_STATE_INVALID',
        `Visa network token creation did not return a PENDING token (status="${tokenStatus || 'unknown'}"). Minting was not initiated as expected; not printing a payment_url.`,
      );
    }

    notify(format, 'success', 'Visa network token creation initiated');

    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: tokenData,
      text: () => formatVisaPendingToken(tokenData),
    };

    await renderWithContext(commandResult, { format }, configManager);

    const tokenId = tokenData.id as string;

    // Built-in polling: the payment_url is already printed above, so the user
    // can start the passkey verification in the browser now. The token's ACTIVE
    // is written synchronously by the browser's later `visa/payment/resolve`
    // request (no webhook), so the only way to observe activation is to re-read
    // GET /payment-tokens/{id}. Poll every 5s up to 180s (longer than
    // UnionPay's 60s because completion is driven by a human passkey action,
    // not a backend event) waiting for ACTIVE/FAILED. On timeout the token
    // stays PENDING — print the follow-up `get` hint. Poll unconditionally
    // (also under --yes): the internal orchestrator wants the terminal state.
    notify(
      format,
      'info',
      'Check your email and open the verification link to complete the Visa passkey verification. Waiting for result...',
    );

    const VISA_TOKEN_POLL_INTERVAL_MS = 5000;
    const VISA_TOKEN_POLL_TIMEOUT_MS = 180_000;
    const pollStart = Date.now();

    while (Date.now() - pollStart < VISA_TOKEN_POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, VISA_TOKEN_POLL_INTERVAL_MS));

      const pollResult = await deps.apiClient.get<Record<string, unknown>>(
        `/payment-tokens/${tokenId}`,
        { type: 'api-key', key: apiKey },
      );

      if (pollResult.success) {
        const status = String(pollResult.data.status ?? '');
        if (status === 'ACTIVE') {
          notify(format, 'success', 'Visa network token activated!');
          if (!pollResult.data.type) pollResult.data.type = 'network_token';
          const activatedResult: CommandResult<Record<string, unknown>> = {
            data: pollResult.data,
            text: () => formatVisaActiveToken(pollResult.data),
          };
          await renderWithContext(activatedResult, { format }, configManager);
          return;
        }
        if (status === 'FAILED') {
          notify(format, 'error', 'Visa network token failed.');
          return;
        }
      }
      // Still PENDING — continue polling.
    }

    notify(
      format,
      'info',
      `Timed out waiting for token activation. Check status later with: agenzo-token-cli payment-tokens get ${tokenId}`,
    );
  });
}

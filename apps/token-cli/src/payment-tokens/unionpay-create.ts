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
// Constants
// ============================================================

/**
 * Decimal-amount format used by the `unionpay_amount` intent field.
 * Server expects a plain positive decimal string (e.g. "174.58") — NOT
 * cents. No conversion happens for this field, only format validation.
 */
const DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;

function isValidUnionpayAmount(amountStr: string): boolean {
  const trimmed = amountStr.trim();
  if (!DECIMAL_AMOUNT_RE.test(trimmed)) return false;
  return parseFloat(trimmed) > 0;
}

/** Format a UnionPay network token PENDING response for output (no cryptogram yet). */
function formatUnionpayPendingToken(data: Record<string, unknown>): string {
  const lines: [string, string][] = [
    ['Payment Token ID', String(data.id || '')],
    ['Type', 'Network Token'],
    ['Status', String(data.status || 'PENDING')],
    ['Checkout URL', String(data.checkout_url || '')],
    ['Correlation ID', String(data.correlation_id || '')],
  ];
  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-tokens unionpay-create` — start UnionPay network-token creation
 * (UPI Agent Pay checkout) and return immediately (no polling).
 *
 * This is the non-blocking counterpart to `payment-tokens create --type
 * network-token` against a `payment_brand=unionpay` payment method: it POSTs
 * /payment-tokens/create with the UnionPay intent fields, prints the
 * returned `checkout_url` (+ token id + correlation id, PENDING at this
 * point — no cryptogram yet), then exits. Unlike `create`, it does NOT poll
 * for the terminal ACTIVE/FAILED status — callers poll separately via
 * `payment-tokens get <token_id>` once the user finishes authenticating in
 * the browser/Sheet (the cryptogram arrives asynchronously via the checkout
 * webhook).
 *
 * Intended for programmatic callers (e.g. the agent orchestrator) that need
 * the checkout_url synchronously to render a payment card, rather than a CLI
 * operator waiting at the terminal for the async webhook result. Not
 * advertised in the SKILL/README (mirrors dropin-create / unionpay-enroll).
 */
export function registerUnionpayCreateCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('unionpay-create')
    .description('Start a UnionPay network-token checkout and return the checkout_url (no polling)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--payment-method-id <id>', 'UnionPay payment method ID to use (required)')
    .option('--recipient-first-name <name>', 'Recipient first name (order delivery details)')
    .option('--recipient-last-name <name>', 'Recipient last name (order delivery details)')
    .option('--recipient-email <email>', 'Recipient email (recipient-email or recipient-phone required)')
    .option('--recipient-phone <phone>', 'Recipient phone (recipient-email or recipient-phone required)')
    .option('--unionpay-amount <amount>', 'Intent amount as a decimal string, e.g. "174.58" (required)')
    .option(
      '--return-url <url>',
      'Optional front-end redirect URL after UPI payment completes',
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
          'Missing required --payment-method-id for unionpay-create (required in --yes mode)',
        );
      }
      paymentMethodId = await PromptEngine.resolveInput(undefined, {
        message: 'Payment method id:',
        validate: (v) => v.trim().length > 0 || 'Payment method id is required',
      });
    }

    let unionpayAmountStr = opts.unionpayAmount as string | undefined;
    if (!unionpayAmountStr) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --unionpay-amount for unionpay-create (required in --yes mode)',
        );
      }
      unionpayAmountStr = await PromptEngine.resolveInput(undefined, {
        message: 'UnionPay intent amount (USD, e.g. 174.58):',
        validate: (v) => isValidUnionpayAmount(v) || 'Amount must be a positive decimal, e.g. "174.58"',
      });
    }
    if (!isValidUnionpayAmount(unionpayAmountStr)) {
      throw new CliError(
        'PARAM_INVALID',
        `Invalid --unionpay-amount "${unionpayAmountStr}". Expected a positive decimal string, e.g. "174.58".`,
      );
    }

    let recipientFirstName = opts.recipientFirstName as string | undefined;
    if (!recipientFirstName) {
      if (isYes) {
        throw new CliError('PARAM_INVALID', 'Missing required --recipient-first-name');
      }
      recipientFirstName = await PromptEngine.resolveInput(undefined, {
        message: 'Recipient first name:',
        validate: (v) => v.trim().length > 0 || 'Recipient first name is required',
      });
    }

    let recipientLastName = opts.recipientLastName as string | undefined;
    if (!recipientLastName) {
      if (isYes) {
        throw new CliError('PARAM_INVALID', 'Missing required --recipient-last-name');
      }
      recipientLastName = await PromptEngine.resolveInput(undefined, {
        message: 'Recipient last name:',
        validate: (v) => v.trim().length > 0 || 'Recipient last name is required',
      });
    }

    let recipientEmail = opts.recipientEmail as string | undefined;
    let recipientPhone = opts.recipientPhone as string | undefined;
    if (!recipientEmail && !recipientPhone) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          '--recipient-email or --recipient-phone is required for unionpay-create.',
        );
      }
      const emailInput = await PromptEngine.resolveInput(undefined, {
        message: 'Recipient email (optional, press Enter to skip and enter phone instead):',
        validate: () => true,
      });
      if (emailInput.trim()) {
        recipientEmail = emailInput.trim();
      } else {
        const phoneInput = await PromptEngine.resolveInput(undefined, {
          message: 'Recipient phone (required, since no email was given):',
          validate: (v) => v.trim().length > 0 || 'Recipient email or phone is required',
        });
        recipientPhone = phoneInput.trim();
      }
    }

    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payment-tokens unionpay-create');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const body: Record<string, unknown> = {
      type: 'network_token',
      payment_method_id: paymentMethodId,
      unionpay_amount: unionpayAmountStr.trim(),
      recipient_first_name: recipientFirstName,
      recipient_last_name: recipientLastName,
      ...(recipientEmail ? { recipient_email: recipientEmail } : {}),
      ...(recipientPhone ? { recipient_phone: recipientPhone } : {}),
      ...(opts.returnUrl ? { return_url: String(opts.returnUrl) } : {}),
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

    notify(format, 'success', 'UnionPay network token creation initiated');

    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: tokenData,
      text: () => formatUnionpayPendingToken(tokenData),
    };

    await renderWithContext(commandResult, { format }, configManager);

    const tokenId = tokenData.id as string;
    notify(
      format,
      'info',
      'Open the Checkout URL to complete the UnionPay payment verification, then check status with: ' +
        `agenzo-token-cli payment-tokens get ${tokenId}`,
    );
  });
}

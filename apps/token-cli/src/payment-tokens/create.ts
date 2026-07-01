import { Command } from 'commander';
import { confirm, select } from '@inquirer/prompts';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  createSpinner,
  resolveFormat,
  notify,
  CliError,
  IdempotencyKeyRequiredError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult, OutputFormat } from '@agenzo/cli-core';
import type { PaymentMethod } from '../types/api.js';

// ============================================================
// Constants
// ============================================================

/** Default network-token fee in cents when /config/network-token-fee is unreachable. */
const DEFAULT_NT_FEE_CENTS = 50;

/** Smallest USDC unit (1 USDC = 1_000_000 micro-units). */
const USDC_UNIT = 1_000_000;

/**
 * Decimal-amount format used by the `unionpay_amount` intent field.
 * Server expects a plain positive decimal string (e.g. "174.58") — NOT
 * cents. No conversion happens for this field, only format validation.
 */
const DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;

// ============================================================
// Helpers (token-domain-specific — stays in app per requirement 5.5)
// ============================================================

/**
 * Map CLI `--type` flag value to the server-side `type` field.
 * `network-token` → `network_token`; unknown values pass through unchanged.
 */
export function mapTokenType(cliType: string): string {
  if (cliType === 'network-token') return 'network_token';
  return cliType;
}

/**
 * Convert a USD amount string (e.g. "12.50") to integer cents using
 * string-based parsing to avoid floating-point drift.
 *
 * Accepts formats: "12", "12.5", "12.50", ".50", "0.01".
 * Throws PARAM_INVALID on non-numeric / out-of-range.
 */
export function usdToCents(amountStr: string): number {
  const trimmed = amountStr.trim();

  // Validate format: optional digits, optional decimal point with up to 2 fractional digits
  if (!/^\d*\.?\d{0,2}$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new CliError('PARAM_INVALID', `Invalid amount format: "${amountStr}". Expected a decimal like "12.50".`);
  }

  const parts = trimmed.split('.');
  const integerPart = parts[0] || '0';
  let fractionalPart = parts[1] || '0';

  // Pad fractional to exactly 2 digits
  fractionalPart = fractionalPart.padEnd(2, '0');

  const integerCents = parseInt(integerPart, 10) * 100;
  const fractionalCents = parseInt(fractionalPart, 10);
  return integerCents + fractionalCents;
}

/**
 * Resolve the payment method to use, following 4-level priority:
 * 1. --payment-method-id (explicit)
 * 2. --card (match last4 against ACTIVE cards)
 * 3. Single ACTIVE card → auto-select
 * 4. Multiple ACTIVE cards → interactive select
 *
 * Throws CLIENT_NO_PAYMENT_METHOD when no ACTIVE cards exist.
 * Throws CLIENT_CARD_NOT_MATCHED when --card doesn't match any ACTIVE card.
 */
export async function resolvePaymentMethod(
  apiClient: ApiClient,
  apiKey: string,
  opts: {
    paymentMethodId?: string;
    card?: string;
    yes?: boolean;
  },
): Promise<string> {
  // Priority 1: explicit --payment-method-id
  if (opts.paymentMethodId) {
    return opts.paymentMethodId;
  }

  // Need to fetch ACTIVE cards for priorities 2–4
  const result = await apiClient.get<PaymentMethod[]>(
    '/payment-methods',
    { type: 'api-key', key: apiKey },
  );

  if (!result.success) {
    throw CliError.fromApi(result, { auth: 'api-key' });
  }

  const activeCards = result.data.filter((m) => m.status === 'ACTIVE');

  if (activeCards.length === 0) {
    throw new CliError(
      'CLIENT_NO_PAYMENT_METHOD',
      'No active payment methods found. Add one with: agenzo-token-cli payment-methods add --api-key <your_key>',
    );
  }

  // Priority 2: --card (match last4)
  if (opts.card) {
    const matched = activeCards.find((m) => m.last4 === opts.card);
    if (!matched) {
      throw new CliError(
        'CLIENT_CARD_NOT_MATCHED',
        `No active card ending in ${opts.card}. Available: ${activeCards.map((m) => m.last4 || '????').join(', ')}`,
      );
    }
    return matched.id;
  }

  // Priority 3: single card → auto-select
  if (activeCards.length === 1) {
    return activeCards[0].id;
  }

  // Priority 4: multiple cards → interactive select
  if (opts.yes) {
    // In --yes mode we cannot prompt; if there's ambiguity, we cannot proceed
    throw new CliError(
      'PARAM_INVALID',
      'Multiple active payment methods found. Specify --payment-method-id or --card to disambiguate.',
    );
  }

  const selected = await select({
    message: 'Select a payment method:',
    choices: activeCards.map((m) => ({
      name: `${m.id} (${m.brand || m.type} ****${m.last4 || '????'})`,
      value: m.id,
    })),
  });

  return selected;
}

/**
 * Format a payment token for human-readable output (§3.4.1 create output).
 * Renders differently per type: VCN / Network Token / X402.
 *
 * NOTE: The server response wraps type-specific data under `data.vcn`,
 * `data.network_token`, or `data.x402` (nested). This formatter reads
 * from that nested structure directly.
 */
export function formatPaymentToken(data: Record<string, unknown>): string {
  const type = data.type as string;
  const lines: [string, string][] = [];

  if (type === 'vcn') {
    const vcn = data.vcn as Record<string, unknown> | undefined ?? data;
    lines.push(['Payment Token ID', String(data.id || vcn.id || '')]);
    lines.push(['Type', 'VCN']);
    lines.push(['Card Number', String(vcn.card_number || '')]);
    lines.push(['Expiry', String(vcn.expiry || '')]);
    lines.push(['CVC', String(vcn.cvc || '')]);
    lines.push(['Limit', `$${formatCentsToUsd(vcn.amount_limit as number)}`]);
    lines.push(['Currency', String(vcn.currency || 'USD')]);
    lines.push(['Status', String(vcn.status || data.status || '')]);
  } else if (type === 'network_token') {
    if (data.status === 'PENDING' && data.checkout_url) {
      // UnionPay async PENDING response is flat (no `network_token` sub-object,
      // no cryptogram yet — that arrives later via checkout webhook).
      lines.push(['Payment Token ID', String(data.id || '')]);
      lines.push(['Type', 'Network Token']);
      lines.push(['Status', 'PENDING']);
      lines.push(['Checkout URL', String(data.checkout_url || '')]);
      lines.push(['Correlation ID', String(data.correlation_id || '')]);
    } else {
      const nt = data.network_token as Record<string, unknown> | undefined ?? data;
      lines.push(['Payment Token ID', String(data.id || nt.id || '')]);
      lines.push(['Type', 'Network Token']);
      lines.push(['Brand', String(nt.payment_brand || nt.brand || '')]);
      const eci = nt.eci || '';
      if (eci) lines.push(['ECI', String(eci)]);
      lines.push(['Cryptogram', String(nt.token_cryptogram || nt.cryptogram || '')]);
      lines.push(['Expiry', String(nt.expiry_date || nt.expiry || '')]);
      lines.push(['Token Number', String(nt.value || '')]);
    }
  } else if (type === 'x402') {
    const x402 = data.x402 as Record<string, unknown> | undefined ?? data;
    lines.push(['Payment Token ID', String(data.id || x402.id || '')]);
    lines.push(['Type', 'X402']);
    lines.push(['Signature Value', String(x402.signature_value || '')]);
    lines.push(['Status', String(x402.status || data.status || '')]);
  } else {
    // Unknown type: best-effort
    lines.push(['Payment Token ID', String(data.id || '')]);
    lines.push(['Type', String(type || 'unknown')]);
    lines.push(['Status', String(data.status || '')]);
  }

  return Formatter.keyValue(lines);
}

/** Format cents back to USD string (e.g. 1250 → "12.50"). */
function formatCentsToUsd(cents: number | undefined): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Validate the `unionpay_amount` intent field: a positive decimal string
 * (e.g. "174.58"). No cents conversion — the server expects the decimal
 * string verbatim.
 */
function isValidUnionpayAmount(amountStr: string): boolean {
  const trimmed = amountStr.trim();
  if (!DECIMAL_AMOUNT_RE.test(trimmed)) return false;
  return parseFloat(trimmed) > 0;
}

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-tokens create` — generate a VCN / Network Token / X402 credential
 * (§3.4.1).
 */
export function registerCreateCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('create')
    .description('Create a payment token (VCN / Network Token / X402)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--type <type>', 'Token type: vcn | network-token | x402')
    .option('--payment-method-id <id>', 'Payment method ID to use')
    .option('--card <last4>', 'Match payment method by last 4 digits')
    .option('--member <member_id>', 'Member ID')
    .option('--amount <amount>', 'Amount in USD (VCN / X402)')
    .option('--currency <currency>', 'Currency (default: USD)')
    .option('--pay-to <address>', 'Pay-to address (X402)')
    .option('--nonce <nonce>', 'Nonce (X402)')
    .option('--network <network>', 'Network (X402)')
    .option('--deadline <deadline>', 'Deadline (X402)')
    .option('--external-tx-id <id>', 'External transaction ID')
    .option('--recipient-first-name <name>', 'UnionPay network token: recipient first name (order delivery details)')
    .option('--recipient-last-name <name>', 'UnionPay network token: recipient last name (order delivery details)')
    .option('--recipient-email <email>', 'UnionPay network token: recipient email (recipient-email or recipient-phone required)')
    .option('--recipient-phone <phone>', 'UnionPay network token: recipient phone (recipient-email or recipient-phone required)')
    .option('--unionpay-amount <amount>', 'UnionPay network token: intent amount as a decimal string, e.g. "174.58"')
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

    // --- Resolve token type ---
    const cliType = await PromptEngine.resolveInput(opts.type as string | undefined, {
      message: 'Token type:',
      type: 'select',
      choices: [
        { name: 'VCN (Virtual Card Number)', value: 'vcn' },
        { name: 'Network Token', value: 'network-token' },
        { name: 'X402 (USDC on-chain)', value: 'x402' },
      ],
    });
    const serverType = mapTokenType(cliType);

    // --- Resolve payment method (4-level priority) ---
    const paymentMethodId = await resolvePaymentMethod(deps.apiClient, apiKey, {
      paymentMethodId: opts.paymentMethodId as string | undefined,
      card: opts.card as string | undefined,
      yes: isYes,
    });

    // --- For network tokens, fetch the selected PM's `payment_brand` up front ---
    // (needed to branch evo vs. unionpay below, and to enforce that unionpay
    // cards may only be selected via --payment-method-id, never --card).
    let selectedPmPaymentBrand: string | undefined;
    if (serverType === 'network_token') {
      const pmResult = await deps.apiClient.get<PaymentMethod>(
        `/payment-methods/${paymentMethodId}`,
        { type: 'api-key', key: apiKey },
      );
      if (!pmResult.success) {
        throw CliError.fromApi(pmResult, { auth: 'api-key' });
      }
      selectedPmPaymentBrand = pmResult.data.payment_brand;

      if (selectedPmPaymentBrand === 'unionpay' && opts.card && !opts.paymentMethodId) {
        throw new CliError(
          'PARAM_INVALID',
          'UnionPay cards must be selected via --payment-method-id; --card (last4 matching) is not supported for unionpay payment brand.',
        );
      }
    }
    const isUnionpayNetworkToken = serverType === 'network_token' && selectedPmPaymentBrand === 'unionpay';

    // --- Resolve member ---
    // UnionPay: member_id is already on file for this payment method (captured
    // at `payment-methods add --payment-brand unionpay --member <id>` — it
    // drives the UPI consumer identity server-side). Never prompt for it again
    // here: it would just duplicate what the PM already knows, and the two
    // values could silently drift apart. Omit --member entirely for unionpay;
    // if the caller passes it anyway, forward it verbatim and let the server
    // validate it against the PM's own member_id (mismatch → error).
    let member: string | undefined = opts.member as string | undefined;
    if (!member && !isYes && !isUnionpayNetworkToken) {
      // In interactive mode, prompt for member (optional — allow empty)
      const memberInput = await PromptEngine.resolveInput(undefined, {
        message: 'Member ID (optional, press Enter to skip):',
        validate: () => true, // always valid (optional)
      });
      if (memberInput.trim()) {
        member = memberInput.trim();
      }
    }
    // In --yes mode, or for unionpay, if --member not provided, omit it (don't prompt).

    // --- Type-specific branch logic ---
    let freezeAmountCents: number | undefined;
    let feeCents: number | undefined;
    let feeDisplay: string | undefined;
    let freezeDisplay: string | undefined;
    // Body fields that vary by type
    const typeBody: Record<string, unknown> = {};

    if (serverType === 'vcn') {
      // VCN branch: feature gate + amount + fee
      await checkVcnFeatureEnabled(deps.apiClient, apiKey);

      const amountStr = await PromptEngine.resolveInput(opts.amount as string | undefined, {
        message: 'Amount (USD, e.g. 25.00):',
        validate: (v) => {
          try {
            const cents = usdToCents(v);
            if (cents < 1 || cents > 50000) {
              return 'Amount must be between $0.01 and $500.00';
            }
            return true;
          } catch {
            return 'Invalid amount format. Use a decimal like "25.00"';
          }
        },
      });

      const cents = usdToCents(amountStr);
      if (cents < 1 || cents > 50000) {
        throw new CliError(
          'PARAM_INVALID',
          'Amount must be between $0.01 and $500.00',
        );
      }

      feeCents = Math.max(1, Math.round(cents * 0.05));
      freezeAmountCents = cents + feeCents;
      feeDisplay = `$${formatCentsToUsd(feeCents)}`;
      freezeDisplay = `$${formatCentsToUsd(freezeAmountCents)}`;

      typeBody.amount = cents;
      // §3.4.1: --currency omitted → do NOT send; server applies its default.
      if (opts.currency) {
        typeBody.currency = opts.currency as string;
      }
    } else if (serverType === 'network_token') {
      if (isUnionpayNetworkToken) {
        // UnionPay branch: no fee/freeze concept here (fee bypass is a
        // server-side concern — see task 15.3). Skip fee lookup entirely.
        // Collect intent fields instead: recipient info + unionpay_amount.
        const unionpayAmountStr = await PromptEngine.resolveInput(
          opts.unionpayAmount as string | undefined,
          {
            message: 'UnionPay intent amount (USD, e.g. 174.58):',
            validate: (v) => isValidUnionpayAmount(v) || 'Amount must be a positive decimal, e.g. "174.58"',
          },
        );
        if (!isValidUnionpayAmount(unionpayAmountStr)) {
          throw new CliError(
            'PARAM_INVALID',
            `Invalid --unionpay-amount "${unionpayAmountStr}". Expected a positive decimal string, e.g. "174.58".`,
          );
        }
        typeBody.unionpay_amount = unionpayAmountStr.trim();

        typeBody.recipient_first_name = await PromptEngine.resolveInput(
          opts.recipientFirstName as string | undefined,
          {
            message: 'Recipient first name:',
            validate: (v) => v.trim().length > 0 || 'Recipient first name is required',
          },
        );
        typeBody.recipient_last_name = await PromptEngine.resolveInput(
          opts.recipientLastName as string | undefined,
          {
            message: 'Recipient last name:',
            validate: (v) => v.trim().length > 0 || 'Recipient last name is required',
          },
        );

        let recipientEmail = opts.recipientEmail as string | undefined;
        let recipientPhone = opts.recipientPhone as string | undefined;
        if (!recipientEmail && !recipientPhone) {
          if (isYes) {
            throw new CliError(
              'PARAM_INVALID',
              '--recipient-email or --recipient-phone is required for unionpay network tokens.',
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
        if (recipientEmail) typeBody.recipient_email = recipientEmail;
        if (recipientPhone) typeBody.recipient_phone = recipientPhone;
      } else {
        // Evo branch (default): fetch fee config (fallback to default)
        feeCents = await fetchNetworkTokenFee(deps.apiClient, apiKey);
        freezeAmountCents = feeCents;
        feeDisplay = `$${formatCentsToUsd(feeCents)}`;
        freezeDisplay = feeDisplay;
      }
    } else if (serverType === 'x402') {
      // X402 branch: USDC amount + fee
      const amountStr = await PromptEngine.resolveInput(opts.amount as string | undefined, {
        message: 'Amount (USDC):',
        validate: (v) => {
          const n = parseFloat(v);
          if (isNaN(n) || n <= 0) return 'Amount must be a positive number';
          return true;
        },
      });

      const amountUsdc = parseFloat(amountStr);
      const amountUnits = Math.round(amountUsdc * USDC_UNIT);
      // Fee = max(0.01 USDC units, amount * 5%)
      const minFeeUnits = Math.round(0.01 * USDC_UNIT); // 10000 units = $0.01
      const percentFeeUnits = Math.round(amountUnits * 0.05);
      const feeUnits = Math.max(minFeeUnits, percentFeeUnits);
      const freezeUnits = amountUnits + feeUnits;

      feeDisplay = `${(feeUnits / USDC_UNIT).toFixed(6)} USDC`;
      freezeDisplay = `${(freezeUnits / USDC_UNIT).toFixed(6)} USDC`;

      typeBody.amount = amountUnits;
      typeBody.pay_to = await PromptEngine.resolveInput(opts.payTo as string | undefined, {
        message: 'Pay-to address:',
      });
      typeBody.nonce = await PromptEngine.resolveInput(opts.nonce as string | undefined, {
        message: 'Nonce:',
      });
      typeBody.network = await PromptEngine.resolveInput(opts.network as string | undefined, {
        message: 'Network:',
      });
      const deadlineStr = await PromptEngine.resolveInput(opts.deadline as string | undefined, {
        message: 'Deadline (Unix timestamp):',
        validate: (v) =>
          /^\d+$/.test(v.trim()) || 'Deadline must be a Unix timestamp (integer seconds)',
      });
      // §3.4.1 request body requires `deadline: <number>` — coerce and validate
      // (covers both the --deadline flag path and the interactive path).
      const deadlineNum = Number(deadlineStr.trim());
      if (!Number.isInteger(deadlineNum) || deadlineNum <= 0) {
        throw new CliError(
          'PARAM_INVALID',
          `Invalid deadline: "${deadlineStr}". Expected a Unix timestamp (integer seconds).`,
        );
      }
      typeBody.deadline = deadlineNum;
    }

    // --- Confirmation (unless --yes) ---
    if (!isYes) {
      if (freezeDisplay !== undefined && feeDisplay !== undefined) {
        const warningLines = [`Freeze: ${freezeDisplay}`, `Fee: ${feeDisplay}`];
        notify(format, 'warning', warningLines.join(' | '));
      } else if (isUnionpayNetworkToken) {
        notify(format, 'info', 'UnionPay: no fee (clearing network not yet enabled)');
      }

      const confirmMessage = isUnionpayNetworkToken
        ? 'Proceed with UnionPay network token request?'
        : 'Proceed with token creation?';
      const confirmed = await confirm({
        message: confirmMessage,
        default: true,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Token creation cancelled by user');
      }
    }

    // --- Idempotency key (required for write) ---
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payment-tokens create');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    // --- Build request body ---
    const body: Record<string, unknown> = {
      type: serverType,
      payment_method_id: paymentMethodId,
      ...typeBody,
    };
    if (member) {
      body.member_id = member;
    }
    if (opts.externalTxId) {
      body.external_tx_id = opts.externalTxId as string;
    }

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    // --- POST /payment-tokens/create ---
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/payment-tokens/create',
      { type: 'api-key', key: apiKey },
      body,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const tokenData = result.data;
    // Ensure type is on the top-level data for formatPaymentToken
    if (!tokenData.type) {
      tokenData.type = serverType;
    }

    // --- Output ---
    notify(format, 'success', 'Payment token created');

    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: tokenData,
      text: () => {
        let output = formatPaymentToken(tokenData);
        // X402: append info message about X-PAYMENT header
        if (serverType === 'x402') {
          output += '\n' + Formatter.status('info', 'Use the Signature Value in the X-PAYMENT request header');
        }
        return output;
      },
    };

    await renderWithContext(commandResult, { format }, configManager);

    // UnionPay network tokens are async (PENDING at this point) — poll
    // GET /payment-tokens/{id} every 5s up to 60s waiting for ACTIVE/FAILED.
    if (isUnionpayNetworkToken) {
      notify(
        format,
        'info',
        'Open the Checkout URL to complete the UnionPay payment verification. Waiting for result...',
      );

      const UNIONPAY_TOKEN_POLL_INTERVAL_MS = 5000;
      const UNIONPAY_TOKEN_POLL_TIMEOUT_MS = 60_000;
      const pollStart = Date.now();
      const tokenId = tokenData.id as string;

      while (Date.now() - pollStart < UNIONPAY_TOKEN_POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, UNIONPAY_TOKEN_POLL_INTERVAL_MS));

        const pollResult = await deps.apiClient.get<Record<string, unknown>>(
          `/payment-tokens/${tokenId}`,
          { type: 'api-key', key: apiKey },
        );

        if (pollResult.success) {
          const status = pollResult.data.status as string;
          if (status === 'ACTIVE') {
            notify(format, 'success', 'UnionPay network token activated!');
            if (!pollResult.data.type) pollResult.data.type = serverType;
            const activatedResult: CommandResult<Record<string, unknown>> = {
              data: pollResult.data,
              text: () => formatPaymentToken(pollResult.data),
            };
            await renderWithContext(activatedResult, { format }, configManager);
            return;
          }
          if (status === 'FAILED') {
            notify(format, 'error', 'UnionPay network token failed.');
            return;
          }
        }
        // Still PENDING — continue polling
      }

      notify(format, 'info', `Timed out waiting for token activation. Check status later with: payment-tokens get ${tokenId}`);
    }
  });
}

// ============================================================
// Type-branch helpers
// ============================================================

/**
 * VCN feature gate: GET /features/vcn — if disabled, throw TOKEN_FEATURE_DISABLED.
 */
async function checkVcnFeatureEnabled(apiClient: ApiClient, apiKey: string): Promise<void> {
  const result = await apiClient.get<{ enabled: boolean }>(
    '/features/vcn',
    { type: 'api-key', key: apiKey },
  );

  if (!result.success) {
    // If the endpoint fails, treat as feature disabled (conservative)
    throw CliError.fromApi(result, { auth: 'api-key' });
  }

  if (!result.data.enabled) {
    throw new CliError(
      'TOKEN_FEATURE_DISABLED',
      'VCN creation is not supported yet. Coming soon.',
    );
  }
}

/**
 * Fetch network-token fee from /config/network-token-fee.
 * Falls back to DEFAULT_NT_FEE_CENTS (50) if unreachable.
 */
async function fetchNetworkTokenFee(apiClient: ApiClient, apiKey: string): Promise<number> {
  try {
    const result = await apiClient.get<{ fee_cents: number }>(
      '/config/network-token-fee',
      { type: 'api-key', key: apiKey },
    );

    if (result.success && typeof result.data.fee_cents === 'number') {
      return result.data.fee_cents;
    }
    // Unreachable / unexpected shape → fallback
    return DEFAULT_NT_FEE_CENTS;
  } catch {
    // Network error / timeout → fallback
    return DEFAULT_NT_FEE_CENTS;
  }
}

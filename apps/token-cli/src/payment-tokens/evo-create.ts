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
 * EVO network tokens carry the charge amount as **integer cents** via the
 * top-level `amount` field — NOT a decimal string and NOT with any unit
 * conversion. The value is passed through byte-for-byte
 * (--amount-cents 12345 → amount:12345). This mirrors Visa's integer-cents
 * convention (nested `visa.order_amount_cents`) and contrasts UnionPay's
 * `unionpay_amount`, a plain decimal string (design D4 / R13.3). The platform
 * writes this amount into `preauth_total_cents` at mint time so the later
 * `/pay` capture charges the real amount.
 *
 * Valid inputs are positive integers in the inclusive range
 * [1, 999,999,999,999] (aligned with R13.6): a bare run of digits with no sign,
 * no decimal point, no thousands separators and no scientific notation.
 *
 * The STRICT pre-send rejection of a flag-supplied `--amount-cents` that is a
 * decimal / non-numeric / zero / out-of-range — throwing
 * `CliError('PARAM_INVALID')` with a non-zero exit BEFORE any request is sent —
 * runs in the command action below (it guards the flag path, which bypasses the
 * interactive prompt). Interactive input is validated inline via this helper,
 * and the integer is parsed for the request body (pass-through, no conversion).
 */
const INTEGER_CENTS_RE = /^\d+$/;
const AMOUNT_CENTS_MIN = 1;
const AMOUNT_CENTS_MAX = 999_999_999_999;

/** True when `amountStr` is a positive integer in [1, 999,999,999,999] cents. */
function isValidAmountCents(amountStr: string): boolean {
  const trimmed = amountStr.trim();
  if (!INTEGER_CENTS_RE.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= AMOUNT_CENTS_MIN && n <= AMOUNT_CENTS_MAX;
}

/**
 * Parse a `--amount-cents` string into the integer the request body requires —
 * pass-through, no unit conversion (--amount-cents 12345 → amount:12345). EVO
 * amounts never go through `cents_to_decimal`. Interactive callers reach this
 * via the validated prompt; the flag path's strict validation is task 4.2.
 */
function parseAmountCents(amountStr: string): number {
  return Number(amountStr.trim());
}

/**
 * Format an EVO network token response for output.
 *
 * EVO minting is **synchronous ACTIVE with NO URL** — there is no browser step
 * (cardholder authentication was already enforced at Drop-in card binding), so
 * this deliberately emits neither `payment_url` nor `checkout_url`. It surfaces
 * the token id + status (+ brand when present) only.
 */
function formatEvoActiveToken(data: Record<string, unknown>): string {
  const lines: [string, string][] = [
    ['Payment Token ID', String(data.id || '')],
    ['Type', 'Network Token'],
    ['Status', String(data.status || '')],
  ];
  if (data.payment_brand) {
    lines.push(['Payment Brand', String(data.payment_brand)]);
  }
  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-tokens evo-create` — mint an EVO network token synchronously and
 * return immediately (no polling, no URL).
 *
 * This is the non-blocking, EVO counterpart to `payment-tokens visa-create` /
 * `unionpay-create` against a `payment_brand=evo` payment method. It is a
 * dedicated command rather than a reuse of `create --type network-token`:
 * `create` is the blocking, brand-detecting operator command, whereas this is a
 * lean programmatic mint (design §2.2). It POSTs /payment-tokens/create with a
 * `type=network_token` body carrying the top-level integer-cents `amount` (so
 * the platform records `preauth_total_cents`), then prints the returned token
 * id + status and exits. Unlike Visa/UnionPay, EVO minting is synchronous
 * ACTIVE with cryptogram and NO URL — there is no passkey/checkout page to open
 * and nothing to poll (cardholder auth happened at Drop-in binding).
 *
 * Intended for programmatic callers (e.g. the agent orchestrator) that mint an
 * EVO token in one shot before capturing. Not advertised in the SKILL/README
 * and does NOT register attachSchemaHelp (mirrors visa-create / unionpay-create
 * / dropin-create).
 *
 * Registered in `src/index.ts`'s payment-tokens group in task 4.3 (this export
 * is the seam for that registration).
 */
export function registerEvoCreateCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('evo-create')
    .description('Mint an EVO network token synchronously and return it (no polling, no URL)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--payment-method-id <id>', 'EVO payment method ID to use (required)')
    .option(
      '--amount-cents <cents>',
      'Charge amount in integer cents, e.g. 12345 for $123.45 (required)',
    )
    .option('--currency <currency>', 'Currency code, e.g. USD (optional)')
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
          'Missing required --payment-method-id for evo-create (required in --yes mode)',
        );
      }
      paymentMethodId = await PromptEngine.resolveInput(undefined, {
        message: 'Payment method id:',
        validate: (v) => v.trim().length > 0 || 'Payment method id is required',
      });
    }

    let amountCentsStr = opts.amountCents as string | undefined;
    if (!amountCentsStr) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --amount-cents for evo-create (required in --yes mode)',
        );
      }
      amountCentsStr = await PromptEngine.resolveInput(undefined, {
        message: 'Charge amount in integer cents (e.g. 12345 for $123.45):',
        validate: (v) =>
          isValidAmountCents(v) ||
          'Amount must be a positive integer in cents (1..999,999,999,999), no decimals',
      });
    }

    // Strict integer/range validation (R7.3 / R13.6): reject decimals /
    // non-numeric / zero / out-of-range up-front so no minting request is sent
    // for a bad amount. This guards the `--amount-cents` FLAG path (which
    // bypasses the interactive prompt above, notably in `--yes` mode); the
    // range here is [1, 999,999,999,999] (12 digits, R13.6) — WIDER than
    // visa-create's [1, 99,999,999]. The value is passed through unconverted
    // (--amount-cents 12345 → amount:12345, no unit conversion).
    if (!isValidAmountCents(amountCentsStr)) {
      throw new CliError(
        'PARAM_INVALID',
        `Invalid --amount-cents "${amountCentsStr}". Expected a positive integer in cents (1..999,999,999,999), no decimals.`,
      );
    }
    const amountCents = parseAmountCents(amountCentsStr);

    const currency = (opts.currency as string | undefined)?.trim() || undefined;

    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payment-tokens evo-create');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    // Request body (R7.2 / R13.3): `type=network_token` + top-level integer
    // `amount` (byte-for-byte pass-through) + optional `currency`. Deliberately
    // NO `visa` sub-object, NO recipient_* fields, NO return_url — EVO minting
    // is a single synchronous call with no browser handshake.
    const body: Record<string, unknown> = {
      type: 'network_token',
      payment_method_id: paymentMethodId,
      amount: amountCents,
      ...(currency ? { currency } : {}),
    };

    // Exactly one POST /payment-tokens/create; `--idempotency-key` forwarded
    // verbatim as the Idempotency-Key header.
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

    // status === 'ACTIVE' guard (R7.6 — the new guard relative to
    // visa-create's PENDING guard): EVO minting is SYNCHRONOUS ACTIVE — the
    // platform returns a fully minted token with cryptogram and NO URL (there
    // is no passkey/checkout page to open and nothing to poll; cardholder auth
    // happened at Drop-in binding). Any status other than ACTIVE means minting
    // did not succeed, so fail with a non-zero exit BEFORE rendering — this
    // runs ahead of notify/renderWithContext so nothing is printed for a token
    // that isn't ACTIVE.
    const tokenStatus = String(tokenData.status ?? '');
    if (tokenStatus !== 'ACTIVE') {
      throw new CliError(
        'RESOURCE_STATE_INVALID',
        `EVO network token creation did not return an ACTIVE token (status="${tokenStatus || 'unknown'}"). EVO minting is synchronous ACTIVE; a non-ACTIVE status means minting did not succeed.`,
      );
    }

    notify(format, 'success', 'EVO network token created');

    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: tokenData,
      text: () => formatEvoActiveToken(tokenData),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

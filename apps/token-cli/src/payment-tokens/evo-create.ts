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
      '--member <member_id>',
      "End-user member id this token is minted for; forwarded to the request body as member_id (optional). Programmatic callers (the agent orchestrator) inject it from the authenticated session, never from the model — see verb-schema's 'session' source. Omit it and the token is developer-scoped.",
    )
    .option(
      '--amount-cents <cents>',
      'Charge amount in integer cents, e.g. 12345 for $123.45 (required)',
    )
    .option('--currency <currency>', 'Currency code, e.g. USD (optional)')
    .option(
      '--external-transaction-id <id>',
      'Order id to bind this token to; forwarded to the request body as external_transaction_id (optional)',
    )
    .option(
      '--provider-id <id>',
      'Acquiring provider this payment is settled under; forwarded to the request body as provider_id (optional). Omit it to settle on your default store. A value that has not been configured for you is rejected with PROVIDER_NOT_CONFIGURED (409).',
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
    // Scope the token to an end-user when supplied (body field `member_id`,
    // same contract as `payment-tokens create`). Deliberately NOT prompted for
    // when absent: this is a lean programmatic mint, and its callers inject the
    // member from the authenticated session — an interactive prompt here would
    // only matter to operators, who have `create` for that.
    const member = (opts.member as string | undefined)?.trim() || undefined;
    // Bind the token to a merchant order (order_id) when supplied. Maps to the
    // platform create_token request body field `external_transaction_id`
    // (distinct from the generic `payment-tokens create --external-tx-id`,
    // which maps to `external_tx_id`).
    const externalTransactionId = (opts.externalTransactionId as string | undefined)?.trim() || undefined;
    // 承接供应商（收单门店路由）。「没声明」与「声明了无效值」是两件事，判据是**这个 flag 有没有
    // 出现**（present 判断），不是真值判断：`""` / `"   "` 属于「已声明但无效」，必须原样上送，
    // 由平台以 409 PROVIDER_NOT_CONFIGURED fail-closed。若在这里折叠成 undefined，这笔款会被悄悄
    // 落到默认门店。取值不 trim、不折叠大小写、不校验格式——合法性的唯一判据是平台的映射表。
    // 与上面 --member / --external-transaction-id 的写法不同是刻意的，不要「顺手统一」。
    const providerId = opts.providerId as string | undefined;

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
      ...(member ? { member_id: member } : {}),
      ...(externalTransactionId ? { external_transaction_id: externalTransactionId } : {}),
      ...(providerId !== undefined ? { provider_id: providerId } : {}),
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

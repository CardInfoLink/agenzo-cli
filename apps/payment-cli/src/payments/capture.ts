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
  /** Record-only price annotation echoed back by the server; null when not declared. */
  original_amount_cents?: number | null;
  discount_amount_cents?: number | null;
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
      '--provider-id <id>',
      "Restate the acquiring provider declared on the token, for consistency checking only (optional). When given it MUST equal the token's own provider_id, otherwise the charge is rejected with PROVIDER_MISMATCH (409). It never rewrites the token and cannot move a token to another store; omit it to use the token's declared value.",
    )
    .option(
      '--original-amount-cents <cents>',
      'Original (pre-discount) price in integer cents. Optional, RECORD-ONLY: stored on our ' +
        'own charge record and echoed back in the result, never sent to the acquiring gateway ' +
        'and never used to derive or validate the amount charged (that always comes from the token).',
    )
    .option(
      '--discount-amount-cents <cents>',
      'Discount amount in integer cents. Optional, RECORD-ONLY: same semantics as ' +
        '--original-amount-cents.',
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
    // 承接供应商的**重述**：门店始终来自令牌文档，这里给的值只参与一致性校验（不一致 → 平台 409
    // PROVIDER_MISMATCH），永不改写令牌、也搬不动门店。判据是**这个 flag 有没有出现**（present
    // 判断），不是真值判断：`""` / `"   "` 属于「已声明但无效」，必须原样上送由平台 fail-closed；
    // 折叠成「没给」会让一次矛盾的重述被悄悄当成「按令牌执行」而漏过校验。取值不 trim、不折叠
    // 大小写、不校验格式。与上面 --member 的写法不同是刻意的，不要「顺手统一」。
    const providerId = opts.providerId as string | undefined;
    if (providerId !== undefined) {
      body.provider_id = providerId;
    }
    // 价格批注（原价 / 优惠，纯记录）：只落平台自己的流水并回显，**不进**发给收单网关的
    // 报文，也不参与扣款金额（金额恒取令牌冻结值）。在本地就把非整数 / 负数挡掉，避免把
    // 一个纯记录字段的格式错误变成一次 422 往返。0 是合法取值（优惠 0 = 明确声明没有优惠），
    // 所以判据是 `< 0` 而不是 `< 1`，且用 present 判断而非真值判断。
    for (const [flag, optKey, bodyKey] of [
      ['--original-amount-cents', 'originalAmountCents', 'original_amount_cents'],
      ['--discount-amount-cents', 'discountAmountCents', 'discount_amount_cents'],
    ] as const) {
      const raw = opts[optKey] as string | undefined;
      if (raw === undefined) continue;
      const cents = Number(raw);
      if (!Number.isInteger(cents) || cents < 0) {
        throw new CliError(
          'PARAM_INVALID',
          `Invalid ${flag} "${raw}". Expected a non-negative integer number of cents (e.g. 10000 for 100.00).`,
        );
      }
      body[bodyKey] = cents;
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
          // 价格批注：声明过才显示（未声明时服务端回 null，不占一行）。
          ...(charge.original_amount_cents !== undefined && charge.original_amount_cents !== null
            ? [
                ['Original', `${formatCents(charge.original_amount_cents)} ${charge.currency}`] as [
                  string,
                  string,
                ],
              ]
            : []),
          ...(charge.discount_amount_cents !== undefined && charge.discount_amount_cents !== null
            ? [
                ['Discount', `${formatCents(charge.discount_amount_cents)} ${charge.currency}`] as [
                  string,
                  string,
                ],
              ]
            : []),
          ...(charge.three_ds_url ? [['3DS URL', charge.three_ds_url] as [string, string]] : []),
          ['Merchant Trans ID', charge.merchant_trans_id ?? '-'],
          ['EVO Trans ID', charge.evo_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

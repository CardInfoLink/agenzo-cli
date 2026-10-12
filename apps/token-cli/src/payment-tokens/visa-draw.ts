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
import {
  isValidOrderAmountCents,
  parseJsonObjectFlag,
  parseOrderAmountCents,
} from './visa-create.js';

/**
 * `payment-tokens visa-draw <payment_token_id>` — 在已有的 Visa 授权下再取一份凭证，
 * 用于对同一授权重复扣款（每笔商品订单取一份，再用 /pay 扣）。
 *
 * POST /payment-tokens/{payment_token_id}/visa/draw。同步返回一枚 ACTIVE 子令牌
 * （平台在库里把它挂在授权令牌下，但响应体不回显 `parent_payment_token_id`，
 * 本地联调实测确认），不需要 passkey，也不轮询。
 *
 * 授权边界（额度、有效期、商户、卡）全部来自已有授权，请求里没有对应字段，所以 CLI
 * 也不提供：不是订阅，没有"是否订阅"之类的参数。额度按取凭证的金额累计占用，
 * 超出由平台以 1403 / `data.reason=authorization_limit_exceeded` 拒绝。
 *
 * `--member` 只是归属交叉校验，选填；CLI 不做任何强制，对不上由平台按"找不到"处理。
 */
export function registerVisaDrawCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('visa-draw <payment_token_id>')
    .description(
      'Draw a fresh Visa credential under an existing authorization (no passkey). Returns a new ACTIVE child token to charge with /pay; the amount counts against the authorization limit',
    )
    .option('--api-key <key>', 'API Key for authentication')
    .option(
      '--order-amount-cents <cents>',
      'Amount of THIS order in integer cents, e.g. 2500 for $25.00 (required). The credential is issued for exactly this amount, so charge the same amount',
    )
    .option('--currency <currency>', 'Currency code; must match the authorization (optional)')
    .option(
      '--external-transaction-id <id>',
      'Your order id, used for reconciliation and as Visa merchantOrderId; defaults to the idempotency key (optional)',
    )
    .option(
      '--order <json>',
      'Order details as ONE JSON object: description (one line: what is being bought) / subtotal_cents / tax_cents / discount_cents / shipping_cents / products[] / shipping_address (optional, all amounts in cents)',
    )
    .option(
      '--member <member_id>',
      'Member ID; cross-checked against the token owner by the platform (optional)',
    )
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header. Use one per order; retrying with the same key never double-counts the limit',
    );

  cmd.action(async (paymentTokenId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    let orderAmountCentsStr = opts.orderAmountCents as string | undefined;
    if (!orderAmountCentsStr) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --order-amount-cents for visa-draw (required in --yes mode)',
        );
      }
      orderAmountCentsStr = await PromptEngine.resolveInput(undefined, {
        message: 'Order amount in integer cents (e.g. 2500 for $25.00):',
        validate: (v) =>
          isValidOrderAmountCents(v) ||
          'Amount must be a positive integer in cents (1..99,999,999), no decimals',
      });
    }
    if (!isValidOrderAmountCents(orderAmountCentsStr)) {
      throw new CliError(
        'PARAM_INVALID',
        `Invalid --order-amount-cents "${orderAmountCentsStr}". Expected a positive integer in cents (1..99,999,999), no decimals.`,
      );
    }

    const currency = (opts.currency as string | undefined)?.trim() || undefined;
    const externalTransactionId =
      (opts.externalTransactionId as string | undefined)?.trim() || undefined;
    const member = (opts.member as string | undefined)?.trim() || undefined;
    // 坏参数先于任何交互提示报错，不会走到发请求。
    const orderDetail =
      opts.order !== undefined ? parseJsonObjectFlag('--order', String(opts.order)) : undefined;

    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (isYes) {
        throw new IdempotencyKeyRequiredError('payment-tokens visa-draw');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per order, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    // 请求体是平台 DrawVisaCredentialRequest 的平铺字段，没有额度/有效期/商户/卡。
    const body: Record<string, unknown> = {
      order_amount_cents: parseOrderAmountCents(orderAmountCentsStr),
      ...(currency ? { currency } : {}),
      ...(externalTransactionId ? { external_transaction_id: externalTransactionId } : {}),
      ...(orderDetail ? { order: orderDetail } : {}),
      ...(member ? { member_id: member } : {}),
    };

    const result = await deps.apiClient.post<Record<string, unknown>>(
      `/payment-tokens/${encodeURIComponent(paymentTokenId)}/visa/draw`,
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

    // 子令牌应当直接是 ACTIVE；其他状态说明取凭证没按预期完成，不当成成功输出。
    const tokenStatus = String(tokenData.status ?? '');
    if (tokenStatus !== 'ACTIVE') {
      throw new CliError(
        'RESOURCE_STATE_INVALID',
        `Visa credential draw did not return an ACTIVE token (status="${tokenStatus || 'unknown'}").`,
      );
    }

    notify(format, 'success', 'Visa credential drawn under the existing authorization');

    const commandResult: CommandResult<Record<string, unknown>> = {
      data: tokenData,
      text: () => {
        const nt = (tokenData.network_token as Record<string, unknown> | undefined) ?? {};
        const lines: [string, string][] = [
          ['Payment Token ID', String(tokenData.id || '')],
          ['Authorization Token ID', paymentTokenId],
          ['Type', 'Network Token'],
          ['Status', String(tokenData.status || 'ACTIVE')],
          ['Network Token (DPAN)', String(nt.value || '')],
          ['Cryptogram (TAVV)', String(nt.cryptogram || '')],
          ['Expiry', String(nt.expiry_date || '')],
        ];
        return Formatter.keyValue(lines);
      },
    };
    await renderWithContext(commandResult, { format }, new ConfigManager());
  });
}

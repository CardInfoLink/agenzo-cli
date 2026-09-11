import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { PayFlightOrderResponse } from '../types/flight.js';
import { resolveIdempotencyKey } from '../idempotency.js';
import { MEMBER_OPTION_DESCRIPTION, memberIdOf } from '../member.js';
import { attachSchemaHelp, flightPayOrderSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/**
 * `flight-flink pay-order` — settle a created order by --order-no (triggers upstream
 * ticketing). AWAITING_PAYMENT → PAID. Non-`--yes` path confirms before the write.
 */
export function registerPayOrderCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('pay-order')
    .description('Settle a created order by --order-no (triggers ticketing)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--member <id>', MEMBER_OPTION_DESCRIPTION)
    .option('--order-no <id>', 'Our order reference from create-order')
    .option('--payment-method-id <id>', 'Optional bound-card id to charge (pay_per_call only)')
    .option('--payment-token-id <id>', 'Optional network-token id (unionpay/visa charge path)')
    .option(
      '--authorized-merchant-trans-id <id>',
      'Resume a 3DS challenge: merchant trans id of an already-authorised preauth',
    )
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightPayOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const orderNo = need(opts.orderNo as string | undefined, 'order-no');

    if (!isYes) {
      const ok = await confirm({
        message: `Pay and ticket order ${orderNo}? This settles the order and issues tickets.`,
        default: false,
      });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Payment aborted by user.');
    }

    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink pay-order',
    });

    const spinner = format === 'json' ? null : createSpinner('Paying flight order...');
    // 支付凭证在 pay 而非 create-order：平台侧 create-order 只锁座位/锁价、分文不碰钱，
    // 扣款发生在这一步。全部可选 —— 省略时平台按订单 billing_mode 自行分流（月结扣额度、
    // 现结选默认卡）。CLI 是薄透传层，不做必填校验。
    const body: Record<string, unknown> = {};

    // 归因 + 归属：orchestrator 从已验签 JWT 注入（`source: 'session'`，对 LLM 不可见）。
    // 订单带 member_id 时平台按它校验归属，缺省则只按 developer+org 判定 —— 见
    // doc/member-id-attribution-design.md 修订后的不变量 2。
    const member = memberIdOf(opts);
    if (member !== undefined) body.member_id = member;
    if (opts.paymentMethodId !== undefined) body.payment_method_id = opts.paymentMethodId as string;
    if (opts.paymentTokenId !== undefined) body.payment_token_id = opts.paymentTokenId as string;
    if (opts.authorizedMerchantTransId !== undefined) {
      body.authorized_merchant_trans_id = opts.authorizedMerchantTransId as string;
    }
    const result = await deps.apiClient.post<PayFlightOrderResponse>(
      `/flight/${encodeURIComponent(orderNo)}/pay`,
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) =>
      Formatter.keyValue([
        ['Order no', String(d.order_no ?? '-')],
        ['Status', String(d.status ?? '-')],
        ['Amount', `${d.amount ?? '-'} ${d.currency ?? ''}`.trim()],
      ]),
    );
  });
}

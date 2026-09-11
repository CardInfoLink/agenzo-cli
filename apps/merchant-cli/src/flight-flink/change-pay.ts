import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { resolveIdempotencyKey } from '../idempotency.js';
import { MEMBER_OPTION_DESCRIPTION, memberIdOf } from '../member.js';
import { attachSchemaHelp, flightChangePaySchema } from '../verb-schema.js';
import { type Deps, need, num, render, resolveApiKey } from './_helpers.js';

/**
 * `flight-flink change-pay` — pay a change request's fee and trigger upstream change
 * ticketing. Charges the change fee like a normal order (UPI network-token when
 * --payment-token-id is given, else EVO), then calls flink pay(type=1) for the change
 * order. Calls POST /flight/change/{change_order_no}/pay with an Idempotency-Key header.
 * Non-`--yes` path confirms (restating amount) before the write.
 * --authorized-merchant-trans-id re-enters this verb after a 3DS challenge: no second
 * authorization is made — the platform reuses the already-authorised preauth, captures it
 * and finishes ticketing.
 */
export function registerChangePayCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('change-pay')
    .description('Pay a change request fee (like a normal order) and trigger change ticketing')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--member <id>', MEMBER_OPTION_DESCRIPTION)
    .option('--change-order-no <id>', 'Change order number')
    .option('--order-no <id>', 'Original order reference (ownership check)')
    .option('--amount <amount>', 'Change fee total in decimal units (change-detail price_total)')
    .option('--currency <currency>', 'ISO 4217 currency code', 'USD')
    .option('--payment-method-id <id>', 'Optional bound-card id (EVO path)')
    .option('--payment-token-id <id>', 'Optional UPI network-token id (unionpay charge path)')
    .option(
      '--authorized-merchant-trans-id <id>',
      'Resume a 3DS challenge: merchant trans id of the already-authorised preauth',
    )
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightChangePaySchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const changeOrderNo = need(opts.changeOrderNo as string | undefined, 'change-order-no');
    const orderNo = need(opts.orderNo as string | undefined, 'order-no');
    const amount = num(opts.amount as string | undefined, 'amount');
    const currency = need(opts.currency as string | undefined, 'currency');
    const body: Record<string, unknown> = {
      order_no: orderNo,
      amount,
      currency,
    };

    // 归因 + 归属：orchestrator 从已验签 JWT 注入（`source: 'session'`，对 LLM 不可见）。
    // 订单带 member_id 时平台按它校验归属，缺省则只按 developer+org 判定 —— 见
    // doc/member-id-attribution-design.md 修订后的不变量 2。
    const member = memberIdOf(opts);
    if (member !== undefined) body.member_id = member;
    if (opts.paymentMethodId !== undefined) body.payment_method_id = opts.paymentMethodId as string;
    // UPI(unionpay) 扣款路径：透传已 ACTIVE 的 network token id；platform change-pay
    // 据 payment_token_id 非空走 ChargeService 实扣（跳过 EVO 预授权/捕获）。
    if (opts.paymentTokenId !== undefined) body.payment_token_id = opts.paymentTokenId as string;
    // 3DS 挑战续付凭证：改签费现结走 EVO 预授权 + 捕获。预授权遇 EVO 要求持卡人认证时资金
    // 尚未冻结，平台返回挑战；前端带用户认证完成后用这个参数重入 change-pay，平台复用那笔
    // 已认证通过的预授权再 capture，不再新发起一次授权（否则每轮都在卡上多冻结一笔）。
    if (opts.authorizedMerchantTransId !== undefined) {
      body.authorized_merchant_trans_id = opts.authorizedMerchantTransId as string;
    }

    if (!isYes) {
      // 续单路径上钱已经扣过了，别再跟操作员说「charges the customer」。
      const isResume = opts.authorizedMerchantTransId !== undefined;
      const message = isResume
        ? `Resume change fee ${amount} ${currency} for change order ${changeOrderNo}? The card is already authorised; this captures it and triggers change ticketing.`
        : `Pay change fee ${amount} ${currency} for change order ${changeOrderNo}? This charges the customer and triggers change ticketing.`;
      const ok = await confirm({ message, default: false });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Change payment aborted by user.');
    }

    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink change-pay',
    });

    const spinner = format === 'json' ? null : createSpinner('Paying change request...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      `/flight/change/${encodeURIComponent(changeOrderNo)}/pay`,
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => {
      // 3DS 挑战：平台把它放在 `challenge` 键下（内含自己的 `status`），顶层没有
      // payment_status。照原样按已扣款渲染会打出一张几乎全是 '-' 的表，并且告诉操作员
      // 「Change fee charged」——而这笔连预授权都还没冻结成功。
      const challenge = (d.challenge ?? null) as Record<string, unknown> | null;
      if (challenge) {
        return [
          Formatter.keyValue([
            ['Change order no', String(challenge.change_order_no ?? '-')],
            ['Status', String(challenge.status ?? '-')],
            ['Amount', `${challenge.amount ?? '-'} ${challenge.currency ?? ''}`.trim()],
            ['Authentication URL', String(challenge.three_ds_url ?? '-')],
            ['Merchant trans id', String(challenge.merchant_trans_id ?? '-')],
          ]),
          Formatter.status(
            'warning',
            'Not charged yet — the card requires 3-D Secure and the funds are not held. '
              + 'Open the authentication URL, then re-run change-pay with '
              + '--authorized-merchant-trans-id <merchant trans id>.',
          ),
        ].join('\n\n');
      }
      return [
        Formatter.keyValue([
          ['Change order no', String(d.change_order_no ?? '-')],
          ['Status', String(d.status ?? '-')],
          ['Amount', `${d.amount ?? '-'} ${d.currency ?? ''}`.trim()],
          ['Payment status', String(d.payment_status ?? '-')],
        ]),
        Formatter.status('info', 'Change fee charged; change ticketing triggered. Poll change-detail until SUCCESS.'),
      ].join('\n\n');
    });
  });
}

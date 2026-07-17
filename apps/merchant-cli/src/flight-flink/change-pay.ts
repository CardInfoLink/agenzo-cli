import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, flightChangePaySchema } from '../verb-schema.js';
import { type Deps, need, num, render, resolveApiKey } from './_helpers.js';

/**
 * `flight-flink change-pay` — pay a change request's fee and trigger upstream change
 * ticketing. Charges the change fee like a normal order (UPI network-token when
 * --payment-token-id is given, else EVO), then calls flink pay(type=1) for the change
 * order. Calls POST /flight/change/{change_order_no}/pay with an Idempotency-Key header.
 * Non-`--yes` path confirms (restating amount) before the write.
 */
export function registerChangePayCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('change-pay')
    .description('Pay a change request fee (like a normal order) and trigger change ticketing')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--change-order-no <id>', 'Change order number')
    .option('--order-no <id>', 'Original order reference (ownership check)')
    .option('--amount <amount>', 'Change fee total in decimal units (change-detail price_total)')
    .option('--currency <currency>', 'ISO 4217 currency code', 'USD')
    .option('--payment-method-id <id>', 'Optional bound-card id (EVO path)')
    .option('--payment-token-id <id>', 'Optional UPI network-token id (unionpay charge path)')
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
    if (opts.paymentMethodId !== undefined) body.payment_method_id = opts.paymentMethodId as string;
    // UPI(unionpay) 扣款路径：透传已 ACTIVE 的 network token id；platform change-pay
    // 据 payment_token_id 非空走 ChargeService 实扣（跳过 EVO 预授权/捕获）。
    if (opts.paymentTokenId !== undefined) body.payment_token_id = opts.paymentTokenId as string;

    if (!isYes) {
      const ok = await confirm({
        message: `Pay change fee ${amount} ${currency} for change order ${changeOrderNo}? This charges the customer and triggers change ticketing.`,
        default: false,
      });
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
    await render(result.data, opts.format as string | undefined, (d) =>
      [
        Formatter.keyValue([
          ['Change order no', String(d.change_order_no ?? '-')],
          ['Status', String(d.status ?? '-')],
          ['Amount', `${d.amount ?? '-'} ${d.currency ?? ''}`.trim()],
          ['Payment status', String(d.payment_status ?? '-')],
        ]),
        Formatter.status('info', 'Change fee charged; change ticketing triggered. Poll change-detail until SUCCESS.'),
      ].join('\n\n'),
    );
  });
}

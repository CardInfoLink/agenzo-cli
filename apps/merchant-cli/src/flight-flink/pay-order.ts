import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { PayFlightOrderResponse } from '../types/flight.js';
import { resolveIdempotencyKey } from '../idempotency.js';
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
    .option('--order-no <id>', 'Our order reference from create-order')
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
    const result = await deps.apiClient.post<PayFlightOrderResponse>(
      `/flight/${encodeURIComponent(orderNo)}/pay`,
      { type: 'api-key', key: apiKey },
      {},
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

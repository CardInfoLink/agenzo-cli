import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { CancelFlightResponse } from '../types/flight.js';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, flightCancelOrderSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/**
 * `flight-flink cancel-order` — cancel an un-ticketed order by --order-no (with
 * refund). A ticketed order is rejected upstream. Non-`--yes` path confirms first.
 */
export function registerCancelOrderCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('cancel-order')
    .description('Cancel an un-ticketed flight order (with refund)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-no <id>', 'Our order reference')
    .option('--reason <text>', 'Optional cancellation reason')
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightCancelOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const orderNo = need(opts.orderNo as string | undefined, 'order-no');

    if (!isYes) {
      const ok = await confirm({
        message: `Cancel order ${orderNo}? This requests cancellation and a refund.`,
        default: false,
      });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Cancellation aborted by user.');
    }

    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink cancel-order',
    });

    const body: Record<string, unknown> = {};
    if (opts.reason !== undefined) body.reason = opts.reason as string;

    const spinner = format === 'json' ? null : createSpinner('Cancelling flight order...');
    const result = await deps.apiClient.post<CancelFlightResponse>(
      `/flight/${encodeURIComponent(orderNo)}/cancel`,
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
        ['Refund amount', `${d.refund_amount ?? '-'} ${d.currency ?? ''}`.trim()],
      ]),
    );
  });
}

import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightRefundDetailSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink refund-detail` — refund request detail by --refund-order-no. */
export function registerRefundDetailCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('refund-detail')
    .description('Refund request detail by refund order number')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--refund-order-no <id>', 'Refund order number');
  attachSchemaHelp(cmd, flightRefundDetailSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const refundOrderNo = need(opts.refundOrderNo as string | undefined, 'refund-order-no');

    const spinner = format === 'json' ? null : createSpinner('Fetching refund detail...');
    const result = await deps.apiClient.get<Record<string, unknown>>(
      `/flight/refund/${encodeURIComponent(refundOrderNo)}`,
      { type: 'api-key', key: apiKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

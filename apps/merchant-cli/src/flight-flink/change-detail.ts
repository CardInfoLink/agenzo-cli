import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightChangeDetailSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink change-detail` — change request detail by --change-order-no. */
export function registerChangeDetailCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('change-detail')
    .description('Change request detail by change order number')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--change-order-no <id>', 'Change order number');
  attachSchemaHelp(cmd, flightChangeDetailSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const changeOrderNo = need(opts.changeOrderNo as string | undefined, 'change-order-no');

    const spinner = format === 'json' ? null : createSpinner('Fetching change detail...');
    const result = await deps.apiClient.get<Record<string, unknown>>(
      `/flight/change/${encodeURIComponent(changeOrderNo)}`,
      { type: 'api-key', key: apiKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

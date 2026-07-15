import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightChangeSearchSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink change-search` — search rebook-eligible flights for an order. */
export function registerChangeSearchCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('change-search')
    .description('Search rebook-eligible flights for an order')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-no <id>', 'Our order reference')
    .option('--date <date>', 'Target change date YYYY-MM-DD')
    .option('--passenger <code>', 'passengerCode')
    .option('--segment-id <ids>', 'Comma-separated segment ids')
    .option('--cabin-class <c>', 'Cabin class', 'economy');
  attachSchemaHelp(cmd, flightChangeSearchSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const body = {
      order_no: need(opts.orderNo as string | undefined, 'order-no'),
      date: need(opts.date as string | undefined, 'date'),
      passenger: need(opts.passenger as string | undefined, 'passenger'),
      segment_id: need(opts.segmentId as string | undefined, 'segment-id'),
      cabin_class: opts.cabinClass as string,
    };

    const spinner = format === 'json' ? null : createSpinner('Searching change options...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/flight/change/search',
      { type: 'api-key', key: apiKey },
      body,
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

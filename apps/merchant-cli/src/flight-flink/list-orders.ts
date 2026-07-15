import { Command } from 'commander';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { ListFlightOrdersResponse } from '../types/flight.js';
import { attachSchemaHelp, flightListOrdersSchema } from '../verb-schema.js';
import { type Deps, num, render, resolveApiKey } from './_helpers.js';

/** `flight-flink list-orders` — list the developer's flight orders (local read). */
export function registerListOrdersCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('list-orders')
    .description("List the developer's flight orders (local read, no upstream call)")
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--status <status>', 'Optional status filter')
    .option('--page <n>', 'Page (1-based)', '1')
    .option('--page-size <n>', 'Items per page (1-100)', '20');
  attachSchemaHelp(cmd, flightListOrdersSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const params = new URLSearchParams();
    if (opts.status !== undefined) params.set('status', opts.status as string);
    params.set('page', String(num(opts.page as string | undefined, 'page')));
    params.set('page_size', String(num(opts.pageSize as string | undefined, 'page-size')));

    const spinner = format === 'json' ? null : createSpinner('Fetching flight orders...');
    const result = await deps.apiClient.get<ListFlightOrdersResponse>(
      `/flight/orders?${params.toString()}`,
      { type: 'api-key', key: apiKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => {
      const rows = (d.orders ?? []).map((o) => [
        String(o.order_no ?? '-'),
        String(o.status ?? '-'),
        `${o.total_amount ?? '-'} ${o.currency ?? ''}`.trim(),
      ]);
      return Formatter.table(['Order no', 'Status', 'Amount'], rows);
    });
  });
}

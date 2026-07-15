import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightListAirlinesSchema } from '../verb-schema.js';
import { type Deps, num, render, resolveApiKey } from './_helpers.js';

/** `flight-flink list-airlines` — paged airline dictionary. */
export function registerListAirlinesCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('list-airlines')
    .description('Paged airline dictionary')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--page <n>', 'Page (1-based)', '1')
    .option('--page-size <n>', 'Items per page (1-100)', '20')
    .option('--keyword <text>', 'Optional name filter');
  attachSchemaHelp(cmd, flightListAirlinesSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const body: Record<string, unknown> = {
      page: num(opts.page as string | undefined, 'page'),
      page_size: num(opts.pageSize as string | undefined, 'page-size'),
    };
    if (opts.keyword !== undefined) body.keyword = opts.keyword as string;

    const spinner = format === 'json' ? null : createSpinner('Fetching airlines...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/flight/airlines',
      { type: 'api-key', key: apiKey },
      body,
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

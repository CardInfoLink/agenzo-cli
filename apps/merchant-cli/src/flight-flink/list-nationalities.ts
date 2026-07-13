import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightListNationalitiesSchema } from '../verb-schema.js';
import { type Deps, render, resolveApiKey } from './_helpers.js';

/** `flight-flink list-nationalities` — nationality list (no params). */
export function registerListNationalitiesCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('list-nationalities')
    .description('Nationality list')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');
  attachSchemaHelp(cmd, flightListNationalitiesSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const spinner = format === 'json' ? null : createSpinner('Fetching nationalities...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/flight/nationalities',
      { type: 'api-key', key: apiKey },
      {},
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

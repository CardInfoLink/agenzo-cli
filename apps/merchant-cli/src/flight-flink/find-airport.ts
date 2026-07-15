import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightFindAirportSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink find-airport` — resolve free-text into city/airport candidates. */
export function registerFindAirportCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('find-airport')
    .description('Resolve free-text into city/airport candidates')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--keyword <text>', 'Free-text place/airport/city name');
  attachSchemaHelp(cmd, flightFindAirportSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const keyword = need(opts.keyword as string | undefined, 'keyword');

    const spinner = format === 'json' ? null : createSpinner('Resolving airports...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/flight/find-airport',
      { type: 'api-key', key: apiKey },
      { keyword },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) =>
      JSON.stringify(d.airports ?? d, null, 2),
    );
  });
}

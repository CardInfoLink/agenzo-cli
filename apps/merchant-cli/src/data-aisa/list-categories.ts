import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, dataListCategoriesSchema } from '../verb-schema.js';
import { type Deps, render, resolveApiKey } from './_helpers.js';

/** `data-aisa list-categories` — the data categories and how many capabilities each holds. */
export function registerDataListCategoriesCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('list-categories')
    .description(
      'List the data categories and how many capabilities each one holds. Free (answered from the bundled index, no upstream call), read-only.',
    )
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');
  attachSchemaHelp(cmd, dataListCategoriesSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const spinner = format === 'json' ? null : createSpinner('Fetching data categories...');
    const result = await deps.apiClient.get<Record<string, unknown>>('/data/categories', {
      type: 'api-key',
      key: apiKey,
    });
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

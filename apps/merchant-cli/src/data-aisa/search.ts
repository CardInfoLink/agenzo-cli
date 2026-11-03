import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, dataSearchSchema } from '../verb-schema.js';
import { type Deps, num, render, resolveApiKey } from './_helpers.js';

/** `data-aisa search` — find a data capability by keyword (free, read-only). */
export function registerDataSearchCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('search')
    .description(
      'Find a data capability by keyword. Free (answered from the bundled index, no upstream call), read-only. Returns operationId + method + tags + summary + price_usd for each hit.',
    )
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option(
      '--keyword <kw>',
      "What to look for, e.g. 'crypto price' or 'reddit'. Space- or comma-separated tokens; omitted returns the first --limit capabilities as examples.",
    )
    .option('--limit <n>', 'How many hits to return (1-50)', '15');
  attachSchemaHelp(cmd, dataSearchSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    // ApiClient.get takes Record<string,string>, so every query param is
    // stringified here. `--keyword` has no default: it is only sent when given.
    // `--limit` carries commander's '15' default, so it is always sent.
    const params: Record<string, string> = {};
    if (opts.keyword !== undefined) params.keyword = String(opts.keyword);
    if (opts.limit !== undefined) {
      params.limit = String(num(opts.limit as string | undefined, 'limit'));
    }

    const spinner = format === 'json' ? null : createSpinner('Searching data capabilities...');
    const result = await deps.apiClient.get<Record<string, unknown>>(
      '/data/search',
      { type: 'api-key', key: apiKey },
      params,
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

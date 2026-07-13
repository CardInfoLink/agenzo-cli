import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, flightMoreOffersSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink more-offers` — more fare offers for a priceKey. */
export function registerMoreOffersCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('more-offers')
    .description('More fare offers for a priceKey (carried by product_token)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--product-token <token>', 'Opaque token from search');
  attachSchemaHelp(cmd, flightMoreOffersSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const productToken = need(opts.productToken as string | undefined, 'product-token');

    const spinner = format === 'json' ? null : createSpinner('Fetching offers...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/flight/more-offers',
      { type: 'api-key', key: apiKey },
      { product_token: productToken },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

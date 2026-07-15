import { Command } from 'commander';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { VerifyFlightResponse } from '../types/flight.js';
import { attachSchemaHelp, flightVerifySchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink verify` — pre-booking price verification. */
export function registerVerifyCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('verify')
    .description('Verify the latest price before booking; returns the authoritative product_token')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--product-token <token>', 'Opaque token from search');
  attachSchemaHelp(cmd, flightVerifySchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const productToken = need(opts.productToken as string | undefined, 'product-token');

    const spinner = format === 'json' ? null : createSpinner('Verifying price...');
    const result = await deps.apiClient.post<VerifyFlightResponse>(
      '/flight/verify',
      { type: 'api-key', key: apiKey },
      { product_token: productToken },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) =>
      Formatter.keyValue([
        ['Product token', String(d.product_token ?? '-')],
        ['Total price', `${d.total_price ?? '-'} ${d.currency ?? ''}`.trim()],
        ['Price changed', String(d.price_changed)],
      ]),
    );
  });
}

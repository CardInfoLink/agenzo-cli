import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, dataDescribeSchema } from '../verb-schema.js';
import { type Deps, kv, need, render, resolveApiKey } from './_helpers.js';

/** `data-aisa describe` — one capability's parameter spec + unit price (free, read-only). */
export function registerDataDescribeCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('describe')
    .description(
      "Read one capability's parameter spec, usage hint and unit price before calling it. Free (answered from the bundled index, no upstream call), read-only.",
    )
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--operation-id <id>', 'Which capability to describe — an operationId returned by search, verbatim');
  attachSchemaHelp(cmd, dataDescribeSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const operationId = need(opts.operationId as string | undefined, 'operation-id');
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const spinner = format === 'json' ? null : createSpinner('Fetching capability spec...');
    const result = await deps.apiClient.get<Record<string, unknown>>(
      `/data/describe/${encodeURIComponent(operationId)}`,
      { type: 'api-key', key: apiKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => kv(d));
  });
}

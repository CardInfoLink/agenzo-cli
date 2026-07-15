import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, flightChangeCancelSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink change-cancel` — cancel a change request (immediate terminal). */
export function registerChangeCancelCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('change-cancel')
    .description('Cancel a change request (immediate terminal)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--change-order-no <id>', 'Change order number')
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightChangeCancelSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const changeOrderNo = need(opts.changeOrderNo as string | undefined, 'change-order-no');

    if (!isYes) {
      const ok = await confirm({ message: `Cancel change request ${changeOrderNo}?`, default: false });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Change cancellation aborted by user.');
    }
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink change-cancel',
    });

    const spinner = format === 'json' ? null : createSpinner('Cancelling change request...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      `/flight/change/${encodeURIComponent(changeOrderNo)}/cancel`,
      { type: 'api-key', key: apiKey },
      {},
      { 'Idempotency-Key': idempotencyKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

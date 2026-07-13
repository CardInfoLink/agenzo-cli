import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, flightRefundConfirmSchema } from '../verb-schema.js';
import { type Deps, need, render, resolveApiKey } from './_helpers.js';

/** `flight-flink refund-confirm` — confirm ("1") or cancel ("2") a refund. */
export function registerRefundConfirmCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('refund-confirm')
    .description('Confirm ("1") or cancel ("2") a refund')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--refund-order-no <id>', 'Refund order number')
    .option('--confirm <flag>', '"1" confirm / "2" cancel')
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightRefundConfirmSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const refundOrderNo = need(opts.refundOrderNo as string | undefined, 'refund-order-no');
    const confirmFlag = need(opts.confirm as string | undefined, 'confirm');
    if (confirmFlag !== '1' && confirmFlag !== '2') {
      throw new CliError('PARAM_INVALID', '--confirm must be "1" (confirm) or "2" (cancel).');
    }

    if (!isYes) {
      const action = confirmFlag === '1' ? 'confirm' : 'cancel';
      const ok = await confirm({ message: `${action} refund ${refundOrderNo}?`, default: false });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Refund confirmation aborted by user.');
    }
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink refund-confirm',
    });

    const spinner = format === 'json' ? null : createSpinner('Processing refund confirmation...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      `/flight/refund/${encodeURIComponent(refundOrderNo)}/confirm`,
      { type: 'api-key', key: apiKey },
      { confirm: confirmFlag },
      { 'Idempotency-Key': idempotencyKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

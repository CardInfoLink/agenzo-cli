import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, flightRefundApplySchema } from '../verb-schema.js';
import { type Deps, need, num, render, resolveApiKey } from './_helpers.js';

/** `flight-flink refund-apply` — submit a refund request (pending review). */
export function registerRefundApplyCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('refund-apply')
    .description('Submit a refund request (returns refund_order_no, pending review)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-no <id>', 'Our order reference')
    .option('--passenger <code>', 'passengerCode')
    .option('--segment-id <ids>', 'Comma-separated segment ids')
    .option('--reason-type <n>', 'Refund reason type code')
    .option('--reason <text>', 'Free-text reason')
    .option('--contact-name <name>', 'Contact name')
    .option('--contact-region <code>', 'Contact region')
    .option('--contact-phone <phone>', 'Contact phone')
    .option('--contact-email <email>', 'Contact email')
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightRefundApplySchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const body: Record<string, unknown> = {
      order_no: need(opts.orderNo as string | undefined, 'order-no'),
      passenger: need(opts.passenger as string | undefined, 'passenger'),
      segment_id: need(opts.segmentId as string | undefined, 'segment-id'),
      reason_type: num(opts.reasonType as string | undefined, 'reason-type'),
      contact_name: need(opts.contactName as string | undefined, 'contact-name'),
      contact_region: need(opts.contactRegion as string | undefined, 'contact-region'),
      contact_phone: need(opts.contactPhone as string | undefined, 'contact-phone'),
      contact_email: need(opts.contactEmail as string | undefined, 'contact-email'),
    };
    if (opts.reason !== undefined) body.reason = opts.reason as string;

    if (!isYes) {
      const ok = await confirm({
        message: `Submit a refund request for order ${body.order_no}?`,
        default: false,
      });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Refund request aborted by user.');
    }
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink refund-apply',
    });

    const spinner = format === 'json' ? null : createSpinner('Submitting refund request...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/flight/refund/apply',
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

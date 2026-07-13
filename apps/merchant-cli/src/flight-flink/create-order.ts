import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { CreateFlightOrderResponse } from '../types/flight.js';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, flightCreateOrderSchema } from '../verb-schema.js';
import { type Deps, jsonArray, need, num, render, resolveApiKey } from './_helpers.js';

/**
 * `flight-flink create-order` — create a flight order without charging (locks the
 * fare). Calls POST /flight/create-order with an Idempotency-Key header. The order
 * enters AWAITING_PAYMENT and must be settled via pay-order. Non-`--yes` path
 * confirms (restating amount) before the write; a declined confirm → CLIENT_ABORTED.
 */
export function registerCreateOrderCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('create-order')
    .description('Create a flight order without charging (locks the fare, await payment)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--product-token <token>', 'Authoritative rate token from verify')
    .option('--total-amount <amount>', 'Verified total price in decimal units')
    .option('--currency <currency>', 'ISO 4217 currency code')
    .option('--trip-type <n>', '1/2/3', '1')
    .option('--contact-name <name>', 'Booking contact name')
    .option('--contact-region <code>', "Contact phone country code (no '+')")
    .option('--contact-phone <phone>', 'Booking contact phone')
    .option('--contact-email <email>', 'Booking contact email')
    .option('--passengers <json>', 'JSON array of passengers (gender/id_type are strings)')
    .option('--payment-method-id <id>', 'Optional bound-card id (pay_per_call only)')
    .option('--idempotency-key <key>', 'Forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(cmd, flightCreateOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const productToken = need(opts.productToken as string | undefined, 'product-token');
    const totalAmount = num(opts.totalAmount as string | undefined, 'total-amount');
    const currency = need(opts.currency as string | undefined, 'currency');
    const body: Record<string, unknown> = {
      product_token: productToken,
      total_amount: totalAmount,
      currency,
      trip_type: num(opts.tripType as string | undefined, 'trip-type'),
      contact_name: need(opts.contactName as string | undefined, 'contact-name'),
      contact_region: need(opts.contactRegion as string | undefined, 'contact-region'),
      contact_phone: need(opts.contactPhone as string | undefined, 'contact-phone'),
      contact_email: need(opts.contactEmail as string | undefined, 'contact-email'),
      passengers: jsonArray(need(opts.passengers as string | undefined, 'passengers'), 'passengers'),
    };
    if (opts.paymentMethodId !== undefined) body.payment_method_id = opts.paymentMethodId as string;

    if (!isYes) {
      const ok = await confirm({
        message: `Create this flight order for ${totalAmount} ${currency}? This locks the fare but does NOT charge yet.`,
        default: false,
      });
      if (!ok) throw new CliError('CLIENT_ABORTED', 'Order creation aborted by user.');
    }

    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'flight-flink create-order',
    });

    const spinner = format === 'json' ? null : createSpinner('Creating flight order...');
    const result = await deps.apiClient.post<CreateFlightOrderResponse>(
      '/flight/create-order',
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) =>
      [
        Formatter.keyValue([
          ['Order no', String(d.order_no ?? '-')],
          ['Upstream order no', String(d.upstream_order_no ?? '-')],
          ['Status', String(d.status ?? '-')],
          ['Total amount', `${d.total_amount ?? '-'} ${d.currency ?? ''}`.trim()],
        ]),
        Formatter.status(
          'info',
          `Order created (AWAITING_PAYMENT) — settle with 'flight-flink pay-order --order-no ${d.order_no ?? '<order_no>'}'.`,
        ),
      ].join('\n\n'),
    );
  });
}

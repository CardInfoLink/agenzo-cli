import { Command } from 'commander';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { GetFlightOrderResponse } from '../types/flight.js';
import { attachSchemaHelp, flightGetOrderSchema } from '../verb-schema.js';
import { type Deps, need, num, render, resolveApiKey } from './_helpers.js';

const TERMINAL = new Set(['TICKETED', 'CANCELLED', 'FAILED']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `flight-flink get-order` — query order status by --order-no. Read-only. With
 * --watch, polls until a terminal status (TICKETED/CANCELLED/FAILED) or timeout,
 * emitting one NDJSON line per update.
 */
export function registerGetOrderCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('get-order')
    .description('Query a flight order status by id (poll ticketing 5→8)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-no <id>', 'Our order reference')
    .option('--watch', 'Poll until a terminal status, one NDJSON line per update')
    .option('--watch-interval <seconds>', 'Seconds between polls', '5')
    .option('--watch-timeout <seconds>', 'Max seconds to poll', '600');
  attachSchemaHelp(cmd, flightGetOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const orderNo = need(opts.orderNo as string | undefined, 'order-no');
    const path = `/flight/${encodeURIComponent(orderNo)}/status`;
    const auth = { type: 'api-key' as const, key: apiKey };

    if (opts.watch) {
      const interval = num(opts.watchInterval as string | undefined, 'watch-interval') * 1000;
      const timeoutMs = num(opts.watchTimeout as string | undefined, 'watch-timeout') * 1000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await deps.apiClient.get<GetFlightOrderResponse>(path, auth);
        if (!r.success) throw CliError.fromApi(r, { auth: 'api-key' });
        process.stdout.write(`${JSON.stringify(r.data)}\n`);
        if (TERMINAL.has(String(r.data.status))) return;
        if (Date.now() + interval >= deadline) {
          process.stdout.write(`${JSON.stringify({ watch_status: 'timeout', order_no: orderNo })}\n`);
          return;
        }
        await sleep(interval);
      }
    }

    const spinner = format === 'json' ? null : createSpinner('Fetching flight order status...');
    const result = await deps.apiClient.get<GetFlightOrderResponse>(path, auth);
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) =>
      Formatter.keyValue([
        ['Order no', String(d.order_no ?? '-')],
        ['Upstream order no', String(d.upstream_order_no ?? '-')],
        ['PNR', String(d.pnr ?? '-')],
        ['Status', String(d.status ?? '-')],
        ['Total amount', `${d.total_amount ?? '-'} ${d.currency ?? ''}`.trim()],
      ]),
    );
  });
}

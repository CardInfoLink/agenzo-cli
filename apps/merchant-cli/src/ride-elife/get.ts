import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { GetOrderResponse } from '../types/api.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  DEFAULT_WATCH_TIMEOUT_SECONDS,
  resolveSeconds,
  watchRideStatus,
} from './watch.js';
import { attachSchemaHelp, rideGetSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (ride-domain — stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 3.1 / §4.4.1.3) — a catalog code (exit 1), mirroring the
 * sibling quote/book commands' convention.
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

// ============================================================
// Output helper (table summary, non-watch path only)
// ============================================================

/**
 * Render a single ride order as a key/value block for `--format table`.
 * Pickup/dropoff are `from_location`/`to_location` (v3 snake_case, NOT the
 * elife `from`/`to` aliases). Amounts are decimal currency units (NOT cents).
 */
function formatGetOrder(data: GetOrderResponse): string {
  const lines: [string, string][] = [
    ['Ride ID', String(data.ride_id ?? '-')],
    ['Status', String(data.status ?? '-')],
  ];
  if (data.source) lines.push(['Source', String(data.source)]);
  if (data.is_scheduled !== undefined) lines.push(['Scheduled', String(data.is_scheduled)]);
  if (data.from_location) {
    lines.push(['From', String(data.from_location.name ?? '-')]);
  }
  if (data.to_location) {
    lines.push(['To', String(data.to_location.name ?? '-')]);
  }
  if (data.pickup_time !== undefined) lines.push(['Pickup time', String(data.pickup_time)]);
  if (data.vehicle_class) lines.push(['Vehicle class', String(data.vehicle_class)]);
  if (data.price) {
    lines.push(['Price', `${data.price.amount} ${data.price.currency}`]);
  }
  if (data.final_amount !== undefined && data.final_amount !== null) {
    lines.push(['Final amount', String(data.final_amount)]);
  }
  if (data.final_settlement_status) {
    lines.push(['Settlement', String(data.final_settlement_status)]);
  }
  if (data.driver) {
    const driver = data.driver;
    const phone = driver.phone_number ? ` (${driver.phone_number})` : '';
    lines.push(['Driver', `${driver.name ?? '-'}${phone}`]);
  }
  if (data.vehicle) {
    const v = data.vehicle;
    const desc = [v.color, v.make, v.model].filter(Boolean).join(' ') || '-';
    const plate = v.license_plate ? ` [${v.license_plate}]` : '';
    lines.push(['Vehicle', `${desc}${plate}`]);
  }
  if (data.created_at) lines.push(['Created at', String(data.created_at)]);

  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife get` — fetch a ride order status by id (§4.4.1.3 get schema).
 * Read-only (no idempotency key).
 *
 * Two modes:
 *   - Non-`--watch`: a single `GET /ride/<id>/status` → `CommandResult` +
 *     `renderWithContext` (json carries the profile/endpoint envelope).
 *   - `--watch`: hands off to `watch.ts`, which polls until a terminal status
 *     or timeout, writing each result as ONE NDJSON line on stdout. The watch
 *     stream is NOT wrapped in the profile/endpoint envelope (it is a line
 *     stream); on timeout the final line is `{ watch_status:'timeout', ... }`
 *     (design Property 2).
 *
 * Named `registerRideGetCommand` to avoid clashing with the `services get`
 * registration.
 */
export function registerRideGetCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('get')
    .description('Retrieve a ride order status by id (repeatable for polling)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Ride order id (the ride_id returned by `ride-elife book`)')
    .option('--watch', 'Poll until a terminal status, emitting one NDJSON line per update')
    .option(
      '--watch-interval <seconds>',
      `Seconds between polls when --watch is set (default ${DEFAULT_WATCH_INTERVAL_SECONDS})`,
    )
    .option(
      '--watch-timeout <seconds>',
      `Max seconds to poll before giving up (default ${DEFAULT_WATCH_TIMEOUT_SECONDS})`,
    );

  attachSchemaHelp(cmd, rideGetSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });
    const orderId = need(opts.orderId as string | undefined, 'order-id');

    // --watch: NDJSON line stream (no profile/endpoint envelope). The stream
    // itself is the progress, so no spinner/notify is emitted.
    if (opts.watch) {
      await watchRideStatus(deps.apiClient, apiKey, orderId, {
        intervalSeconds: resolveSeconds(
          opts.watchInterval as string | undefined,
          DEFAULT_WATCH_INTERVAL_SECONDS,
        ),
        timeoutSeconds: resolveSeconds(
          opts.watchTimeout as string | undefined,
          DEFAULT_WATCH_TIMEOUT_SECONDS,
        ),
      });
      return;
    }

    // Single-shot: progress line on stderr (silent in json mode).
    notify(format, 'loading', 'Fetching ride status...');

    const result = await deps.apiClient.get<GetOrderResponse>(
      `/ride/${encodeURIComponent(orderId)}/status`,
      { type: 'api-key', key: apiKey },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<GetOrderResponse> = {
      data,
      text: () => formatGetOrder(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

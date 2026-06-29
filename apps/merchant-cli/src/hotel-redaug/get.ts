import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  createSpinner,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { GetHotelOrderResponse } from '../types/hotel.js';
import {
  DEFAULT_ORDER_WATCH_INTERVAL_SECONDS,
  DEFAULT_WATCH_TIMEOUT_SECONDS,
  resolveSeconds,
  watchOrderStatus,
} from './watch.js';
import { attachSchemaHelp, hotelGetSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/get.ts and the sibling
// hotel-redaug/quote.ts and search.ts each define their own need) rather than
// pulled from a shared helpers file. `get` is read-only — no idempotency key.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 5.2 / design §4.4) — a catalog code (exit 1), mirroring the
 * `ride-elife` convention; `PARAM_REQUIRED` is intentionally not used (it is
 * not in the cli-core error catalog).
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
 * Render a single hotel order as a key/value block for `--format table`.
 * `order_status` is the std STRING (PROCESSING|CONFIRMED|CANCELLED|COMPLETED|
 * INIT); `order_status_code` is the integer mirror (2/3/4/5) shown only when
 * present (the provider path carries it; the local-cache fallback omits it).
 * `hotel_confirm_no` is populated once the order reaches CONFIRMED (3) and is
 * null while PROCESSING (2). `total_amount` is a DECIMAL currency unit (NOT
 * cents) — printed verbatim.
 */
function formatGetOrder(data: GetHotelOrderResponse): string {
  const lines: [string, string][] = [
    ['Order ID', String(data.order_id ?? '-')],
    ['FC Order Code', String(data.fc_order_code ?? '-')],
    ['Status', String(data.order_status ?? '-')],
  ];
  if (data.order_status_code !== undefined) {
    lines.push(['Status code', String(data.order_status_code)]);
  }
  if (data.hotel_confirm_no !== undefined && data.hotel_confirm_no !== null) {
    lines.push(['Hotel confirm no', String(data.hotel_confirm_no)]);
  }
  if (data.hotel_name) lines.push(['Hotel', String(data.hotel_name)]);
  if (data.room_name) lines.push(['Room', String(data.room_name)]);
  if (data.check_in) lines.push(['Check-in', String(data.check_in)]);
  if (data.check_out) lines.push(['Check-out', String(data.check_out)]);
  if (data.total_amount !== undefined && data.total_amount !== null) {
    lines.push(['Total amount', String(data.total_amount)]);
  }
  if (data.channel_state) lines.push(['Channel state', String(data.channel_state)]);
  if (data.source) lines.push(['Source', String(data.source)]);

  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug get` — query a hotel order status by id (§ get schema).
 * Read-only (no idempotency key); path built from `--order-id` ONLY (the
 * platform status endpoint `/hotel/{order_id}/status` consumes no supplier
 * reference, so `--fc-order-code` is intentionally not accepted here).
 *
 * Two modes (branching mirrors `ride-elife/get.ts`):
 *   - Non-`--watch`: a single `GET /hotel/<order_id>/status` → `CommandResult` +
 *     `renderWithContext` (json carries the profile/endpoint envelope). Renders
 *     `order_status` (string), `order_status_code` (int, when present),
 *     `hotel_confirm_no`, and the other key fields.
 *   - `--watch`: hands off to `watchOrderStatus` (watch.ts), which polls until a
 *     terminal status (`order_status_code ∈ {3,4,5}` or `order_status ∈
 *     {CONFIRMED, CANCELLED, COMPLETED}`) or timeout, writing each result as ONE
 *     NDJSON line on stdout. The watch stream is NOT wrapped in the
 *     profile/endpoint envelope (it is a line stream); on timeout the final line
 *     is `{ watch_status: 'timeout', ... }`.
 *
 * Required-flag validation (`--order-id`) throws `PARAM_INVALID` BEFORE any
 * request. Named `registerHotelGetCommand` to avoid clashing with the
 * `ride-elife` `registerRideGetCommand` when both are imported into `index.ts`.
 */
export function registerHotelGetCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('get')
    .description('Retrieve a hotel order status by id (repeatable for polling)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Our order reference (coOrderCode) returned by `hotel-redaug book`')
    .option('--watch', 'Poll until a terminal status, emitting one NDJSON line per update')
    .option(
      '--watch-interval <seconds>',
      `Seconds between polls when --watch is set (default ${DEFAULT_ORDER_WATCH_INTERVAL_SECONDS})`,
    )
    .option(
      '--watch-timeout <seconds>',
      `Max seconds to poll before giving up (default ${DEFAULT_WATCH_TIMEOUT_SECONDS})`,
    );

  attachSchemaHelp(cmd, hotelGetSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });
    // Required-flag validation BEFORE any request → PARAM_INVALID. The path is
    // built from --order-id ONLY (no --fc-order-code).
    const orderId = need(opts.orderId as string | undefined, 'order-id');

    // --watch: NDJSON line stream (no profile/endpoint envelope). The stream
    // itself is the progress, so no spinner/notify is emitted.
    if (opts.watch) {
      await watchOrderStatus(deps.apiClient, apiKey, orderId, {
        intervalSeconds: resolveSeconds(
          opts.watchInterval as string | undefined,
          DEFAULT_ORDER_WATCH_INTERVAL_SECONDS,
        ),
        timeoutSeconds: resolveSeconds(
          opts.watchTimeout as string | undefined,
          DEFAULT_WATCH_TIMEOUT_SECONDS,
        ),
      });
      return;
    }

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Fetching hotel order status...');

    const result = await deps.apiClient.get<GetHotelOrderResponse>(
      `/hotel/${encodeURIComponent(orderId)}/status`,
      { type: 'api-key', key: apiKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<GetHotelOrderResponse> = {
      data,
      text: () => formatGetOrder(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

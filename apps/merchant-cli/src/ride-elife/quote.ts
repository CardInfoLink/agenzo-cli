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
import type { QuoteResponse, VehicleClass } from '../types/api.js';
import { attachSchemaHelp, quoteSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (ride-domain — body assembly stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 2.1 / design §4.4.1.3) — a catalog code (exit 1), never
 * `PARAM_REQUIRED` (not in the cli-core error catalog).
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/**
 * Number-ify a coordinate / numeric flag. Non-finite input maps to
 * `PARAM_INVALID`. Coordinates are sent as numbers, never strings (§4.4.1.3).
 */
function num(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isFinite(n)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return n;
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render the quote as a table for `--format table`. Each vehicle class is one
 * row; amounts are decimal currency units (NOT cents) — printed verbatim.
 */
function formatQuote(data: QuoteResponse): string {
  const classes: VehicleClass[] = data.vehicle_classes ?? [];
  if (classes.length === 0) {
    return Formatter.status('info', 'No vehicle classes available for this route');
  }

  const headers = ['Vehicle Class', 'Price', 'Currency', 'Quote ID', 'Pax', 'Luggage'];
  const rows = classes.map((vc) => [
    String(vc.vehicle_class ?? '-'),
    String(vc.price?.amount ?? '-'),
    String(vc.price?.currency ?? '-'),
    String(vc.price?.quote_id ?? '-'),
    String(vc.passenger_capacity ?? '-'),
    String(vc.luggage_capacity ?? '-'),
  ]);

  const lines: [string, string][] = [
    ['Airport transfer', String(data.is_airport_transfer ?? false)],
  ];
  if (data.airport_direction) {
    lines.push(['Airport direction', String(data.airport_direction)]);
  }
  if (data.meet_and_greet) {
    const mg = data.meet_and_greet;
    const mgPrice = mg.price ? ` (${mg.price.amount} ${mg.price.currency})` : '';
    lines.push(['Meet & greet', `${mg.available ? 'available' : 'unavailable'}${mgPrice}`]);
  }

  return `${Formatter.table(headers, rows)}\n${Formatter.keyValue(lines)}`;
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife quote` — request fare quotes between two points (§4.4.1.3).
 *
 * Read-only (no idempotency key). Builds the `/ride/quote` body from flags
 * (coordinates number-ified, missing required → `PARAM_INVALID`), POSTs with
 * the `X-Api-Key` auth, and renders `QuoteResponse` via `renderWithContext`
 * (json carries the profile/endpoint envelope). The progress line is emitted
 * through `notify` so it goes to stderr and stays silent in json mode.
 */
export function registerQuoteCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('quote')
    .description('Request fare quotes for a ride between two points')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--pickup-lat <lat>', 'Pickup latitude')
    .option('--pickup-lng <lng>', 'Pickup longitude')
    .option('--pickup-name <name>', 'Pickup location name')
    .option('--dropoff-lat <lat>', 'Dropoff latitude')
    .option('--dropoff-lng <lng>', 'Dropoff longitude')
    .option('--dropoff-name <name>', 'Dropoff location name')
    .option('--pickup-time <time>', 'Pickup time: epoch seconds, or "now"')
    .option('--passenger-name <name>', 'Lead passenger full name')
    .option('--passenger-phone <phone>', 'Passenger phone (E.164)')
    .option('--passenger-count <n>', 'Passenger count')
    .option('--luggage-count <n>', 'Luggage count')
    .option('--passenger-email <email>', 'Passenger email')
    .option('--children-count <n>', 'Children count');

  attachSchemaHelp(cmd, quoteSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build request body. Coordinates are number-ified; pickup_time accepts the
    // literal "now" or epoch seconds. Missing required fields throw
    // PARAM_INVALID before any request is sent.
    const body: Record<string, unknown> = {
      pickup: {
        lat: num(opts.pickupLat as string | undefined, 'pickup-lat'),
        lng: num(opts.pickupLng as string | undefined, 'pickup-lng'),
        name: need(opts.pickupName as string | undefined, 'pickup-name'),
      },
      dropoff: {
        lat: num(opts.dropoffLat as string | undefined, 'dropoff-lat'),
        lng: num(opts.dropoffLng as string | undefined, 'dropoff-lng'),
        name: need(opts.dropoffName as string | undefined, 'dropoff-name'),
      },
      pickup_time:
        opts.pickupTime === 'now'
          ? 'now'
          : num(opts.pickupTime as string | undefined, 'pickup-time'),
    };

    // Optional passenger / luggage / children fields — included only when set.
    if (opts.passengerName) body.passenger_name = opts.passengerName as string;
    if (opts.passengerPhone) body.passenger_phone = opts.passengerPhone as string;
    if (opts.passengerCount !== undefined) {
      body.passenger_count = num(opts.passengerCount as string, 'passenger-count');
    }
    if (opts.luggageCount !== undefined) {
      body.luggage_count = num(opts.luggageCount as string, 'luggage-count');
    }
    if (opts.childrenCount !== undefined) {
      body.children_count = num(opts.childrenCount as string, 'children-count');
    }
    if (opts.passengerEmail !== undefined) {
      body.passenger_email = opts.passengerEmail as string;
    }

    // Progress line: stderr in table mode, silent in json mode.
    notify(format, 'loading', 'Fetching quotes...');

    const result = await deps.apiClient.post<QuoteResponse>(
      '/ride/quote',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<QuoteResponse> = {
      data,
      text: () => formatQuote(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

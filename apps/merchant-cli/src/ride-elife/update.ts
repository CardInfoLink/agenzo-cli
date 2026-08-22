import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
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
import type { UpdateResponse } from '../types/api.js';
import { attachSchemaHelp, rideUpdateSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (ride-domain — stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (a catalog code, exit 1), mirroring the sibling get/cancel commands.
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/** Parse a numeric flag, rejecting non-numbers as `PARAM_INVALID`. */
function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return parsed;
}

/** Parse an integer flag, rejecting non-integers as `PARAM_INVALID`. */
function int(value: string | undefined, flag: string): number | undefined {
  const parsed = num(value, flag);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be an integer.`);
  }
  return parsed;
}

/**
 * Epoch seconds or the literal `now` (same convention as book/quote). Anything
 * else is `PARAM_INVALID` — the CLI does not guess at date strings.
 */
function pickupTime(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  if (value === 'now') return 'now';
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CliError('PARAM_INVALID', "--pickup-time must be epoch seconds or 'now'.");
  }
  return parsed;
}

/**
 * Build a location object only when at least one of its parts was passed, and
 * require all three parts together — a half-specified point would silently
 * change the route to something the user never asked for.
 */
function location(
  lat: string | undefined,
  lng: string | undefined,
  name: string | undefined,
  side: 'pickup' | 'dropoff',
): { lat: number; lng: number; name: string } | undefined {
  if (lat === undefined && lng === undefined && name === undefined) return undefined;
  if (lat === undefined || lng === undefined || name === undefined) {
    throw new CliError(
      'PARAM_INVALID',
      `--${side}-lat, --${side}-lng and --${side}-name must be passed together.`,
    );
  }
  return {
    lat: num(lat, `${side}-lat`) as number,
    lng: num(lng, `${side}-lng`) as number,
    name,
  };
}

// ============================================================
// Output helper (table summary)
// ============================================================

/** Render the modification outcome, making the per-side result explicit. */
function formatUpdate(data: UpdateResponse): string {
  return Formatter.keyValue([
    ['Ride ID', String(data.ride_id ?? '-')],
    ['Status', String(data.status ?? '-')],
    ['Trip details updated', data.ride_updated ? 'yes' : 'no'],
    ['Passenger updated', data.passenger_updated ? 'yes' : 'no'],
  ]);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife update` — modify an existing ride order. Write op (W/Y).
 *
 * `POST /ride/<order-id>/update` with only the fields the caller passed, plus
 * the `Idempotency-Key` header (never in the body). Trip-side and passenger-side
 * changes are two separate upstream calls with NO transaction, so the response
 * reports each side; a partial application surfaces as `UPSTREAM_ERROR` carrying
 * `data.partial_update`.
 *
 * At least one modifiable field is required — an empty update is rejected
 * client-side as `PARAM_INVALID` before any request is sent, so we never spend
 * an idempotency key on a no-op.
 */
export function registerRideUpdateCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('update')
    .description('Modify an existing ride order (trip details and/or passenger)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Ride order id to modify (the ride_id returned by book)')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    )
    .option('--quote-id <id>', 'New quote id when the fare changes')
    .option('--vehicle-class <class>', 'New vehicle class')
    .option('--price-amount <amount>', 'New fare in decimal currency units (NOT cents)')
    .option('--price-currency <code>', 'ISO 4217 currency code for the new fare')
    .option('--pickup-lat <lat>', 'New pickup latitude')
    .option('--pickup-lng <lng>', 'New pickup longitude')
    .option('--pickup-name <name>', 'New pickup location name')
    .option('--dropoff-lat <lat>', 'New dropoff latitude')
    .option('--dropoff-lng <lng>', 'New dropoff longitude')
    .option('--dropoff-name <name>', 'New dropoff location name')
    .option('--pickup-time <time>', "New pickup time: epoch seconds or 'now'")
    .option('--meet-and-greet', 'Enable meet & greet service')
    .option('--no-meet-and-greet', 'Disable meet & greet service')
    .option('--welcome-sign <text>', 'New welcome sign text (meet & greet)')
    .option('--arrival-flight-no <no>', 'New arrival flight number')
    .option('--arrival-airline <name>', 'New arrival airline name')
    .option('--departure-flight-no <no>', 'New departure flight number')
    .option('--departure-airline <name>', 'New departure airline name')
    .option('--service-area-id <id>', 'Service area id, when the upstream requires re-scoping')
    .option('--passenger-name <name>', 'New passenger full name')
    .option('--passenger-phone <phone>', 'New passenger phone (E.164)')
    .option('--passenger-email <email>', 'New passenger email')
    .option('--luggage-count <count>', 'New luggage count');

  attachSchemaHelp(cmd, rideUpdateSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    const orderId = need(opts.orderId as string | undefined, 'order-id');

    // `--meet-and-greet` / `--no-meet-and-greet` are only meaningful when the
    // user actually passed one: commander materialises `meetAndGreet: true` by
    // default for `--no-` pairs, so an untouched flag must stay out of the body.
    const mgTouched = process.argv.some(
      (a) => a === '--meet-and-greet' || a === '--no-meet-and-greet',
    );

    const body: Record<string, unknown> = {};
    const set = (key: string, value: unknown): void => {
      if (value !== undefined) body[key] = value;
    };
    set('quote_id', opts.quoteId as string | undefined);
    set('vehicle_class', opts.vehicleClass as string | undefined);
    set('price_amount', num(opts.priceAmount as string | undefined, 'price-amount'));
    set('price_currency', opts.priceCurrency as string | undefined);
    set(
      'pickup',
      location(
        opts.pickupLat as string | undefined,
        opts.pickupLng as string | undefined,
        opts.pickupName as string | undefined,
        'pickup',
      ),
    );
    set(
      'dropoff',
      location(
        opts.dropoffLat as string | undefined,
        opts.dropoffLng as string | undefined,
        opts.dropoffName as string | undefined,
        'dropoff',
      ),
    );
    set('pickup_time', pickupTime(opts.pickupTime as string | undefined));
    if (mgTouched) set('meet_and_greet', Boolean(opts.meetAndGreet));
    set('welcome_sign', opts.welcomeSign as string | undefined);
    if (opts.arrivalFlightNo !== undefined || opts.arrivalAirline !== undefined) {
      set('arrival_flight', {
        flight_no: opts.arrivalFlightNo as string | undefined,
        airline: opts.arrivalAirline as string | undefined,
      });
    }
    if (opts.departureFlightNo !== undefined || opts.departureAirline !== undefined) {
      set('departure_flight', {
        flight_no: opts.departureFlightNo as string | undefined,
        airline: opts.departureAirline as string | undefined,
      });
    }
    set('service_area_id', opts.serviceAreaId as string | undefined);
    set('passenger_name', opts.passengerName as string | undefined);
    set('passenger_phone', opts.passengerPhone as string | undefined);
    set('passenger_email', opts.passengerEmail as string | undefined);
    set('luggage_count', int(opts.luggageCount as string | undefined, 'luggage-count'));

    // Reject an empty update before spending an idempotency key on a no-op.
    if (Object.keys(body).length === 0) {
      throw new CliError(
        'PARAM_INVALID',
        'Nothing to update. Pass at least one trip field or one passenger-* flag.',
      );
    }

    // Confirm before the write unless --yes: a modification can re-price the
    // ride upstream. Declining maps to CLIENT_ABORTED (exit 5).
    if (!isYes) {
      const confirmed = await confirm({
        message: `Apply ${Object.keys(body).length} change(s) to ride ${orderId}? The fare may change.`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Update aborted by user.');
      }
    }

    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'ride-elife update',
    });

    const spinner = format === 'json' ? null : createSpinner('Updating ride...');

    const result = await deps.apiClient.post<UpdateResponse>(
      `/ride/${encodeURIComponent(orderId)}/update`,
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<UpdateResponse> = {
      data,
      text: () => formatUpdate(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

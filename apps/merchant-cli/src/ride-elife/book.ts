import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
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
import type { BookResponse } from '../types/api.js';
import { attachSchemaHelp, bookSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (ride-domain — body assembly stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 2.2 / design §4.4.1.3) — a catalog code (exit 1), mirroring the
 * sibling `quote` command's convention.
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/** Number-ify a numeric flag. Non-finite input maps to `PARAM_INVALID`. */
function num(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isFinite(n)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return n;
}

/**
 * Number-ify a seat count and enforce the 0–5 range (design §4.4.1.3 book
 * schema). Out-of-range values map to `PARAM_INVALID`.
 */
function seatCount(value: string, flag: string): number {
  const n = num(value, flag);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    throw new CliError('PARAM_INVALID', `--${flag} must be an integer between 0 and 5.`);
  }
  return n;
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render a booked ride as a key/value block for `--format table`. Amounts are
 * decimal currency units (NOT cents) — printed verbatim.
 */
function formatBook(data: BookResponse): string {
  const lines: [string, string][] = [
    ['Ride ID', String(data.ride_id ?? '-')],
    ['Order ID', String(data.order_id ?? '-')],
    ['Status', String(data.status ?? '-')],
    ['Scheduled', String(data.is_scheduled ?? false)],
    ['Order type', String(data.order_type ?? '-')],
  ];
  if (data.price) {
    lines.push(['Price', `${data.price.amount} ${data.price.currency}`]);
    if (data.price.quote_id) lines.push(['Quote ID', String(data.price.quote_id)]);
  }
  lines.push(['Payment status', String(data.payment_status ?? '-')]);
  // Mode-dependent: monthly_settlement returns billing_entry_id, pay_per_call
  // echoes back payment_order_id.
  if (data.billing_entry_id) lines.push(['Billing entry', String(data.billing_entry_id)]);
  if (data.payment_order_id) lines.push(['Payment order', String(data.payment_order_id)]);

  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife book` — book a ride against a previously returned quote
 * (§4.4.1.3 book schema + §4.4.2.1). Write op (W/Y).
 *
 * Funding is decided server-side by the developer's `billing_mode`:
 *   - monthly_settlement: no payment handle; fare is deducted from the
 *     settlement account (payment_status=ON_ACCOUNT).
 *   - pay_per_call: pass `--payment-order-id` (a PAID order from payment-cli).
 * The CLI MUST NOT accept `--payment-method-id` or card info — the merchant
 * domain never holds a payment credential, so the request body carries at most
 * an optional `payment_order_id` (design Property 5).
 *
 * `POST /ride/book` with `X-Api-Key` auth + the `Idempotency-Key` header (key
 * forwarded verbatim, never in the body). `--yes` skips the confirm; a missing
 * `--idempotency-key` under `--yes` throws `PARAM_IDEMPOTENCY_KEY_REQUIRED`
 * before any request is sent. Renders `BookResponse` via `renderWithContext`
 * (json carries the profile/endpoint envelope); the progress line goes to
 * stderr via `notify` and stays silent in json mode.
 */
export function registerBookCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('book')
    .description('Book a ride using a quote_id returned by quote')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--quote-id <id>', 'Quote id from `ride-elife quote`')
    .option('--vehicle-class <class>', 'Chosen vehicle class')
    .option('--price-amount <amount>', 'Fare in decimal currency units (not cents)')
    .option('--price-currency <currency>', 'Currency code (default USD)')
    .option('--payment-order-id <id>', 'Paid payment order id (pay_per_call mode only)')
    .option('--passenger-name <name>', 'Passenger full name')
    .option('--passenger-phone <phone>', 'Passenger phone')
    .option('--passenger-email <email>', 'Passenger email')
    .option('--luggage-count <n>', 'Luggage count')
    .option('--special-requests <text>', 'Free-text special requests')
    .option('--pickup-lat <lat>', 'Pickup latitude')
    .option('--pickup-lng <lng>', 'Pickup longitude')
    .option('--pickup-name <name>', 'Pickup location name')
    .option('--dropoff-lat <lat>', 'Dropoff latitude')
    .option('--dropoff-lng <lng>', 'Dropoff longitude')
    .option('--dropoff-name <name>', 'Dropoff location name')
    .option('--pickup-time <time>', 'Pickup time: epoch seconds, or "now"')
    .option('--meet-and-greet', 'Enable meet & greet service')
    .option('--meet-and-greet-price <amount>', 'Meet & greet surcharge')
    .option('--welcome-sign <text>', 'Welcome sign text')
    .option('--child-seat-count <n>', 'Number of child seats needed (0-5)')
    .option('--infant-seat-count <n>', 'Number of infant seats needed (0-5)')
    .option('--toddler-seat-count <n>', 'Number of toddler seats needed (0-5)')
    .option('--arrival-flight-no <no>', 'Arrival flight number')
    .option('--arrival-airline <airline>', 'Arrival airline')
    .option('--departure-flight-no <no>', 'Departure flight number')
    .option('--departure-airline <airline>', 'Departure airline')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, bookSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build request body. Required fields throw PARAM_INVALID before any
    // request is sent (mirrors the sibling `quote` command). The body carries
    // NO payment_method_id / card info — at most an optional payment_order_id
    // (design Property 5); funding is decided server-side by billing_mode.
    const quoteId = need(opts.quoteId as string | undefined, 'quote-id');
    const body: Record<string, unknown> = {
      quote_id: quoteId,
      vehicle_class: need(opts.vehicleClass as string | undefined, 'vehicle-class'),
      price_amount: num(opts.priceAmount as string | undefined, 'price-amount'),
      price_currency: (opts.priceCurrency as string | undefined) ?? 'USD',
      passenger_name: need(opts.passengerName as string | undefined, 'passenger-name'),
      passenger_phone: need(opts.passengerPhone as string | undefined, 'passenger-phone'),
    };

    // pay_per_call: optional paid payment order id (the only payment handle the
    // merchant CLI ever forwards). monthly_settlement omits it entirely.
    if (opts.paymentOrderId) body.payment_order_id = opts.paymentOrderId as string;
    if (opts.passengerEmail) body.passenger_email = opts.passengerEmail as string;
    if (opts.luggageCount !== undefined) {
      body.luggage_count = num(opts.luggageCount as string, 'luggage-count');
    }
    if (opts.specialRequests) body.special_requests = opts.specialRequests as string;

    // Pickup / dropoff / pickup_time are included only when supplied (they must
    // match the originating quote). Coordinates are number-ified.
    if (opts.pickupLat || opts.pickupLng || opts.pickupName) {
      body.pickup = {
        lat: num(opts.pickupLat as string | undefined, 'pickup-lat'),
        lng: num(opts.pickupLng as string | undefined, 'pickup-lng'),
        name: need(opts.pickupName as string | undefined, 'pickup-name'),
      };
    }
    if (opts.dropoffLat || opts.dropoffLng || opts.dropoffName) {
      body.dropoff = {
        lat: num(opts.dropoffLat as string | undefined, 'dropoff-lat'),
        lng: num(opts.dropoffLng as string | undefined, 'dropoff-lng'),
        name: need(opts.dropoffName as string | undefined, 'dropoff-name'),
      };
    }
    if (opts.pickupTime) {
      body.pickup_time =
        opts.pickupTime === 'now' ? 'now' : num(opts.pickupTime as string, 'pickup-time');
    }

    if (opts.meetAndGreet) body.meet_and_greet = true;
    if (opts.meetAndGreetPrice !== undefined) {
      body.meet_and_greet_price = num(opts.meetAndGreetPrice as string, 'meet-and-greet-price');
    }
    if (opts.welcomeSign) body.welcome_sign = opts.welcomeSign as string;
    if (opts.childSeatCount !== undefined) {
      body.child_seat_count = seatCount(opts.childSeatCount as string, 'child-seat-count');
    }
    if (opts.infantSeatCount !== undefined) {
      body.infant_seat_count = seatCount(opts.infantSeatCount as string, 'infant-seat-count');
    }
    if (opts.toddlerSeatCount !== undefined) {
      body.toddler_seat_count = seatCount(opts.toddlerSeatCount as string, 'toddler-seat-count');
    }
    if (opts.arrivalFlightNo || opts.arrivalAirline) {
      body.arrival_flight = {
        flight_no: opts.arrivalFlightNo as string | undefined,
        airline: opts.arrivalAirline as string | undefined,
      };
    }
    if (opts.departureFlightNo || opts.departureAirline) {
      body.departure_flight = {
        flight_no: opts.departureFlightNo as string | undefined,
        airline: opts.departureAirline as string | undefined,
      };
    }

    // Confirm before the write unless --yes. The warning/prompt go to stderr;
    // declining maps to CLIENT_ABORTED (exit 5) via the top-level envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Book ride with quote ${quoteId}?`,
        default: true,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Booking cancelled by user.');
      }
    }

    // Idempotency key (requirement 5.3): resolved before the request. Under
    // --yes a missing key is a hard error and no request is sent. The key is
    // sent as a header, never in the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'ride-elife book',
    });

    // Progress line: stderr in table mode, silent in json mode.
    notify(format, 'loading', 'Booking ride...');

    const result = await deps.apiClient.post<BookResponse>(
      '/ride/book',
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<BookResponse> = {
      data,
      text: () => formatBook(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

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
import type { CreateRideOrderResponse } from '../types/api.js';
import { attachSchemaHelp, rideCreateOrderSchema } from '../verb-schema.js';
import { MEMBER_OPTION_DESCRIPTION, memberIdOf } from '../member.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (ride-domain — body assembly stays in app per req 4.4)
// ============================================================

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (a catalog code, exit 1), mirroring the sibling `book` / `quote` commands.
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
 * Validate a passenger phone as E.164 shape (edge fail-fast). The authoritative
 * region-aware validity check runs server-side; this catches obviously
 * malformed input before a request is sent. Accepts spaces/dashes, normalizes
 * them away, and requires a leading "+" country code.
 */
function phone(value: string | undefined, flag: string): string {
  const raw = need(value, flag);
  const cleaned = raw.replace(/[\s-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    throw new CliError(
      'PARAM_INVALID',
      `--${flag} must be a valid international phone number, e.g. +14155552671.`,
    );
  }
  return cleaned;
}

/**
 * Number-ify a seat count and enforce the 0–5 range (mirrors `book`).
 * Out-of-range values map to `PARAM_INVALID`.
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
 * Render the locked order as a key/value block for `--format table`. Amounts
 * are decimal currency units (NOT cents) — printed verbatim. The order
 * reference is resolved from `order_ref` when present, else `order_id` (both
 * carry the authoritative rio_… value).
 */
function formatCreateOrder(data: CreateRideOrderResponse): string {
  const orderRef = String(data.order_ref ?? data.order_id ?? '-');
  const lines: [string, string][] = [
    ['Order ref', orderRef],
    ['Status', String(data.status ?? '-')],
    ['Payment status', String(data.payment_status ?? '-')],
  ];
  if (data.price) {
    lines.push(['Amount', `${data.price.amount} ${data.price.currency}`]);
    if (data.price.quote_id) lines.push(['Quote ID', String(data.price.quote_id)]);
  }
  if (data.is_scheduled !== undefined) lines.push(['Scheduled', String(data.is_scheduled)]);
  if (data.order_type) lines.push(['Order type', String(data.order_type)]);

  return [
    Formatter.keyValue(lines),
    Formatter.status(
      'info',
      `Fare locked (AWAITING_PAYMENT) — bind ${orderRef} as the network token external_transaction_id, ` +
        `then settle with 'ride-elife pay-order --order-id ${orderRef}'. No funds moved yet.`,
    ),
  ].join('\n\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife create-order` — lock a ride fare WITHOUT charging (the first step
 * of the two-step network-token direct-charge flow;
 * ride-network-token-direct-charge R11.1). Mirrors
 * `flight-flink create-order` / `hotel-redaug create-order`: the order enters
 * AWAITING_PAYMENT / payment_status=PENDING, NO funds move, and eLife is NOT
 * called. It returns the authoritative `order_ref` (rio_…) so the caller can
 * mint a network token bound to it (external_transaction_id = order_ref) and
 * then settle via `ride-elife pay-order`.
 *
 * Deliberately carries the SAME trip/quote/passenger/surcharge context as
 * `book` MINUS every payment credential (payment_order_id / payment_method_id /
 * payment_token_id / authorized_merchant_trans_id) — funding is deferred to
 * `pay-order`, so no payment handle is accepted here.
 *
 * `POST /ride/create-order` with `X-Api-Key` auth + the `Idempotency-Key`
 * header (key forwarded verbatim, never in the body). Locking a fare is a real
 * commitment (though not a charge), so the non-`--yes` path confirms (restating
 * amount/currency) before the write; `--yes` skips it and a missing
 * `--idempotency-key` under `--yes` throws `PARAM_IDEMPOTENCY_KEY_REQUIRED`
 * before any request is sent. A declined confirm maps to `CLIENT_ABORTED`.
 */
export function registerRideCreateOrderCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('create-order')
    .description('Lock a ride fare without charging (await payment); returns the order_ref to pay')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--quote-id <id>', 'Quote id from `ride-elife quote`')
    .option('--vehicle-class <class>', 'Chosen vehicle class')
    .option('--price-amount <amount>', 'Fare in decimal currency units (not cents)')
    .option('--price-currency <currency>', 'Currency code (default USD)')
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
    .option('--member <id>', MEMBER_OPTION_DESCRIPTION)
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, rideCreateOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build request body. Required fields throw PARAM_INVALID before any request
    // is sent (mirrors the sibling `book` command). The body carries NO payment
    // credential of any kind — create-order only locks the fare; funding is
    // deferred to `pay-order`.
    const quoteId = need(opts.quoteId as string | undefined, 'quote-id');
    const priceAmount = num(opts.priceAmount as string | undefined, 'price-amount');
    const priceCurrency = (opts.priceCurrency as string | undefined) ?? 'USD';
    const body: Record<string, unknown> = {
      quote_id: quoteId,
      vehicle_class: need(opts.vehicleClass as string | undefined, 'vehicle-class'),
      price_amount: priceAmount,
      price_currency: priceCurrency,
      passenger_name: need(opts.passengerName as string | undefined, 'passenger-name'),
      passenger_phone: phone(opts.passengerPhone as string | undefined, 'passenger-phone'),
      passenger_email: need(opts.passengerEmail as string | undefined, 'passenger-email'),
    };

    // 归因标签（可选）：非空才写入，缺省保持无归属。
    const member = memberIdOf(opts);
    if (member !== undefined) body.member_id = member;
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

    // Confirm before the write unless --yes. Locking a fare is a commitment but
    // NOT a charge — the prompt restates the amount and says so. The prompt goes
    // to stderr; declining maps to CLIENT_ABORTED (exit 5) via the top-level
    // envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Lock this ride fare for ${priceAmount} ${priceCurrency}? This reserves the order (AWAITING_PAYMENT) but does NOT charge yet.`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Order creation aborted by user.');
      }
    }

    // Idempotency key: resolved before the request. Under --yes a missing key is
    // a hard error and no request is sent. The key is sent as a header, never in
    // the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'ride-elife create-order',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Locking ride fare...');

    const result = await deps.apiClient.post<CreateRideOrderResponse>(
      '/ride/create-order',
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
    const commandResult: CommandResult<CreateRideOrderResponse> = {
      data,
      text: () => formatCreateOrder(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

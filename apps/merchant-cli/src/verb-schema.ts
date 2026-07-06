/**
 * `--help --format json` verb-level schema (§4.4.1.3) — merchant domain only.
 *
 * Every ride-elife verb supports `--help --format json`, which prints a single
 * machine-readable JSON object describing the verb instead of commander's
 * default text help. This is the standard way an Agent discovers a verb's
 * flags, response shape, example invocation and (where relevant) error-recovery
 * and polling guidance locally, without a network round-trip.
 *
 * admin-cli / token-cli have no such mode, so this lives in the app (not in
 * cli-core) per requirement 4.4.
 *
 * Mechanism (commander v14): `attachSchemaHelp` overrides a command's
 * `helpInformation`. Commander resolves `--help` BEFORE later argv tokens are
 * applied to options, so the parsed `--format` value is not yet available when
 * help renders — we therefore read it straight from `process.argv`. Only an
 * explicit `--format json` switches to the JSON schema; bare `--help` and
 * `--help --format table` keep commander's default text help.
 */
import type { Command } from 'commander';
import { TERMINAL_STATUSES, DEFAULT_WATCH_INTERVAL_SECONDS } from './ride-elife/watch.js';

const CLI_NAME = 'agenzo-merchant-cli';
const NOUN = 'ride-elife';

// ============================================================
// Schema shape (§4.4.1.3 verb-level schema)
// ============================================================

/** One flag descriptor: type / required / optional default / description / constraints. */
export interface FlagSchema {
  type: string;
  /** `true` / `false`, or the literal `'conditional'` for mode-dependent flags. */
  required: boolean | 'conditional';
  default?: unknown;
  description: string;
  constraints?: string;
}

/** A complete, copy-pasteable example invocation plus what to read from the output. */
export interface ExampleSchema {
  command: string;
  output_summary: string;
}

/** Polling guidance — only status-query verbs (`get`) carry this block. */
export interface PollingSchema {
  recommended_interval_seconds: number;
  terminal_statuses: string[];
  in_progress_statuses: string[];
  field_availability?: Record<string, string>;
}

/**
 * The verb-level schema object emitted by `--help --format json`
 * (§4.4.1.3): `{ cli, noun, verb, description, flags, response, example,
 * [error_recovery], [polling] }`. `error_recovery` / `polling` are optional and
 * present only where the verb warrants them.
 */
export interface VerbSchema {
  cli: string;
  noun: string;
  verb: string;
  description: string;
  flags: Record<string, FlagSchema>;
  /** Key response fields + type descriptions (nested objects allowed). */
  response: Record<string, unknown>;
  example: ExampleSchema;
  error_recovery?: Record<string, string>;
  polling?: PollingSchema;
}

// ============================================================
// Emit + attach mechanism
// ============================================================

/**
 * True only when `--format json` is explicitly present in `argv`. Commander
 * resolves `--help` before applying later option tokens, so the parsed format
 * is not yet available at help-render time; we read argv directly. Bare `--help`
 * and `--help --format table` deliberately return false (keep text help), even
 * though the program defaults `--format` to json — the default is never written
 * into argv.
 */
export function wantsJsonSchema(argv: string[] = process.argv): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format=json') return true;
    if (a === '--format' && argv[i + 1] === 'json') return true;
  }
  return false;
}

/** Print a verb schema as a single pretty-printed JSON object to stdout. */
export function emitSchema(schema: VerbSchema): void {
  console.log(JSON.stringify(schema, null, 2));
}

/**
 * Attach `--help --format json` schema output to a command. When help is
 * requested with an explicit `--format json`, the schema is printed to stdout
 * and an empty string is returned so commander prints nothing further and exits
 * cleanly. Otherwise the original (text) help is rendered unchanged.
 */
export function attachSchemaHelp(cmd: Command, schema: VerbSchema): Command {
  const baseHelp = cmd.helpInformation.bind(cmd);
  cmd.helpInformation = (context) => {
    if (!wantsJsonSchema()) return baseHelp(context);
    emitSchema(schema);
    return '';
  };
  return cmd;
}

// ============================================================
// Ride-elife verb schemas
// ============================================================
//
// Flags / response are kept aligned with each command's ACTUAL flags and the
// cli-core response types (QuoteResponse / BookResponse / GetOrderResponse /
// CancelResponse / ListOrdersResponse). Notably: quote's passenger fields are
// optional here (the command only sends them when set); get's pickup/dropoff
// are `from_location` / `to_location` (v3 snake_case, NOT elife from/to);
// amounts are decimal currency units (NOT cents).

/** `ride-elife quote` schema (§4.4.1.3 quote schema). */
export const quoteSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: NOUN,
  verb: 'quote',
  description: 'Request fare quotes for a ride between two points',
  flags: {
    'pickup-lat': { type: 'float', required: true, description: 'Pickup latitude', constraints: '-90 to 90' },
    'pickup-lng': { type: 'float', required: true, description: 'Pickup longitude', constraints: '-180 to 180' },
    'pickup-name': { type: 'string', required: true, description: 'Pickup location name' },
    'dropoff-lat': { type: 'float', required: true, description: 'Dropoff latitude', constraints: '-90 to 90' },
    'dropoff-lng': { type: 'float', required: true, description: 'Dropoff longitude', constraints: '-180 to 180' },
    'dropoff-name': { type: 'string', required: true, description: 'Dropoff location name' },
    'pickup-time': {
      type: 'int|string',
      required: true,
      description: "Epoch seconds or the literal 'now'",
    },
    'passenger-name': { type: 'string', required: true, description: 'Lead passenger full name' },
    'passenger-phone': { type: 'string', required: true, description: 'Passenger phone in E.164 format (e.g. +14155551234)' },
    'passenger-count': { type: 'int', required: false, description: 'Number of passengers' },
    'luggage-count': { type: 'int', required: false, description: 'Number of luggage items' },
    'passenger-email': { type: 'string', required: false, description: 'Passenger email address' },
    'children-count': { type: 'int', required: false, description: 'Number of children' },
  },
  response: {
    vehicle_classes: {
      type: 'array',
      description: 'Available vehicle options with pricing',
      items: {
        vehicle_class: { type: 'string', description: 'Sedan / SUV / MPV-5 / MPV-7 / Van / Luxury / Train' },
        'price.amount': { type: 'float', description: 'Price in currency units (e.g. 42.50), NOT cents' },
        'price.currency': { type: 'string', description: 'ISO 4217 (e.g. USD)' },
        'price.quote_id': { type: 'string', description: 'Use this in `ride-elife book --quote-id`' },
        passenger_capacity: { type: 'int', description: 'Max passengers' },
        luggage_capacity: { type: 'int', description: 'Max luggage items' },
      },
    },
    meet_and_greet: { type: 'object|null', description: 'Meet & greet availability and price' },
    is_airport_transfer: { type: 'bool', description: 'Whether this is an airport transfer' },
    airport_direction: { type: 'string|null', description: 'pickup / dropoff / null' },
  },
  example: {
    command:
      'agenzo-merchant-cli ride-elife quote --pickup-lat 37.7937 --pickup-lng -122.3956 --pickup-name "1 Market St" --dropoff-lat 37.6213 --dropoff-lng -122.3790 --dropoff-name "SFO Airport" --pickup-time now',
    output_summary:
      'Returns vehicle_classes[] with a quote_id per option. Use quote_id and vehicle_class for booking.',
  },
  error_recovery: {
    VEHICLE_UNAVAILABLE: 'No vehicles for this route/time. Try a different pickup-time or location. Do NOT blindly retry.',
    PARAM_INVALID: 'Fix the offending flag (coordinates must be numbers; required pickup/dropoff/pickup-time present), then retry.',
  },
};

/** `ride-elife book` schema (§4.4.1.3 book schema). Write op (W/Y). */
export const bookSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: NOUN,
  verb: 'book',
  description: 'Book a ride using a quote_id returned by a previous quote call',
  flags: {
    'quote-id': { type: 'string', required: true, description: 'Quote id from quote response (vehicle_classes[].price.quote_id)' },
    'vehicle-class': { type: 'string', required: true, description: 'Vehicle class: Sedan / SUV / MPV-5 / MPV-7 / Van / Luxury / Train' },
    'price-amount': { type: 'float', required: true, description: 'Fare in decimal currency units (NOT cents), from the quote' },
    'price-currency': { type: 'string', required: false, default: 'USD', description: 'ISO 4217 currency code' },
    'payment-order-id': {
      type: 'string',
      required: 'conditional',
      description: 'Required when billing_mode=pay_per_call (a PAID payment order). Forbidden when billing_mode=monthly_settlement',
    },
    'passenger-name': { type: 'string', required: true, description: 'Passenger full name' },
    'passenger-phone': { type: 'string', required: true, description: 'Passenger phone in E.164 format (e.g. +14155551234)' },
    'passenger-email': { type: 'string', required: true, description: 'Passenger email (required by eLife for booking)' },
    'luggage-count': { type: 'int', required: false, description: 'Number of luggage items' },
    'special-requests': { type: 'string', required: false, description: 'Free-text special requests or notes' },
    'pickup-lat': { type: 'float', required: false, description: 'Pickup latitude (must match the quote)', constraints: '-90 to 90' },
    'pickup-lng': { type: 'float', required: false, description: 'Pickup longitude (must match the quote)', constraints: '-180 to 180' },
    'pickup-name': { type: 'string', required: false, description: 'Pickup location name (must match the quote)' },
    'dropoff-lat': { type: 'float', required: false, description: 'Dropoff latitude (must match the quote)', constraints: '-90 to 90' },
    'dropoff-lng': { type: 'float', required: false, description: 'Dropoff longitude (must match the quote)', constraints: '-180 to 180' },
    'dropoff-name': { type: 'string', required: false, description: 'Dropoff location name (must match the quote)' },
    'pickup-time': { type: 'int|string', required: false, description: "Epoch seconds or 'now' (must match the quote)" },
    'meet-and-greet': { type: 'bool', required: false, default: false, description: 'Enable meet & greet service' },
    'meet-and-greet-price': { type: 'float', required: false, description: 'Meet & greet surcharge from the quote (meet_and_greet.price.amount)' },
    'welcome-sign': { type: 'string', required: false, description: 'Welcome sign text (meet & greet)' },
    'child-seat-count': { type: 'int', required: false, description: 'Number of child seats needed', constraints: '0 to 5' },
    'infant-seat-count': { type: 'int', required: false, description: 'Number of infant seats needed', constraints: '0 to 5' },
    'toddler-seat-count': { type: 'int', required: false, description: 'Number of toddler seats needed', constraints: '0 to 5' },
    'arrival-flight-no': { type: 'string', required: false, description: 'Arrival flight number (airport pickup)' },
    'arrival-airline': { type: 'string', required: false, description: 'Arrival airline name' },
    'departure-flight-no': { type: 'string', required: false, description: 'Departure flight number (airport dropoff)' },
    'departure-airline': { type: 'string', required: false, description: 'Departure airline name' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Unique key (1-128 chars [A-Za-z0-9_-]) forwarded verbatim as the Idempotency-Key header; never auto-generated',
    },
  },
  response: {
    ride_id: { type: 'string|int', description: 'Ride identifier — use for `ride-elife get` / `ride-elife cancel`' },
    order_id: { type: 'string|int', description: 'Internal order id for reconciliation' },
    status: { type: 'string', description: 'Ride status (case-sensitive server casing)' },
    is_scheduled: { type: 'bool', description: 'true = scheduled/airport ride; false = realtime' },
    order_type: { type: 'string', description: "'realtime' or 'airport'" },
    price: { type: 'object', description: '{ amount, currency, quote_id }' },
    payment_status: { type: 'string', description: 'PAID (pay_per_call) or ON_ACCOUNT (monthly_settlement)' },
    billing_entry_id: { type: 'string|absent', description: 'Only in monthly_settlement mode' },
    payment_order_id: { type: 'string|absent', description: 'Only in pay_per_call mode (echoes the request)' },
  },
  example: {
    command:
      'agenzo-merchant-cli ride-elife book --quote-id qte_01HZXD --vehicle-class Sedan --price-amount 42.50 --passenger-name "Alice" --passenger-phone +14155551234 --idempotency-key book-123',
    output_summary: 'Returns ride_id. Use ride_id in `ride-elife get` to poll status.',
  },
  error_recovery: {
    QUOTE_EXPIRED: "Re-invoke 'quote' for a fresh quote_id, then retry 'book' with the SAME --idempotency-key.",
    BILLING_MODE_MISMATCH: 'Check Developer.billing_mode. pay_per_call requires --payment-order-id; monthly_settlement forbids it.',
    PAYMENT_ORDER_NOT_PAID: 'Wait for the payment order status=PAID, then retry with the SAME --idempotency-key.',
    PAYMENT_ORDER_ALREADY_CONSUMED: 'Create a new payment order, then retry with the new payment-order-id and a NEW --idempotency-key.',
    ACCOUNT_INSUFFICIENT_BALANCE: 'Top up the settlement account (offline) or pick a cheaper vehicle_class, then retry.',
    BOOKING_FAILED: 'elife rejected after settlement. The message contains a ref: for manual reconciliation. Do NOT auto-retry.',
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Supply --idempotency-key (1-128 chars [A-Za-z0-9_-]); the CLI never generates one under --yes.',
  },
};

/** `ride-elife get` schema (§4.4.1.3 get schema). Read-only, supports `--watch`. */
export const rideGetSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: NOUN,
  verb: 'get',
  description: 'Retrieve a ride order status by id; with --watch, poll until a terminal status',
  flags: {
    'order-id': { type: 'string', required: true, description: 'The numeric ride_id (e.g. 4112961) — use the `ride_id` field from book/list-orders responses, NOT the rio_... order_id' },
    watch: { type: 'bool', required: false, default: false, description: 'Poll until a terminal status, emitting one NDJSON line per update' },
    'watch-interval': { type: 'int', required: false, default: DEFAULT_WATCH_INTERVAL_SECONDS, description: 'Seconds between polls when --watch is set' },
    'watch-timeout': { type: 'int', required: false, default: 600, description: 'Max seconds to poll before giving up' },
  },
  response: {
    ride_id: { type: 'string|int', description: 'Ride identifier' },
    status: { type: 'string', description: 'Pending / Accepted / On my way / Waiting / On board / At destination / Rejected / Cancelled / Customer no show / Driver no show' },
    source: { type: 'string', description: "'local_cache' when served from the local fallback; 'mock' in sandbox" },
    is_scheduled: { type: 'bool', description: 'true = scheduled/airport ride' },
    from_location: { type: 'object', description: 'Pickup { lat, lng, name, address } (v3 snake_case, NOT elife from/to)' },
    to_location: { type: 'object', description: 'Dropoff { lat, lng, name, address }' },
    pickup_time: { type: 'int|string', description: 'Pickup time' },
    vehicle_class: { type: 'string|null', description: 'Vehicle class' },
    price: { type: 'object', description: '{ amount, currency, quote_id }' },
    final_amount: { type: 'float|null', description: 'Final settled fare (realtime, after final-fare settlement)' },
    final_settlement_status: { type: 'string', description: 'pending / settled / no_adjustment / settlement_pending / not_applicable' },
    driver: { type: 'object|null', description: '{ name, phone_number } — available after a driver is assigned' },
    vehicle: { type: 'object|null', description: '{ make, model, color, license_plate, image_url } — available after a driver is assigned' },
    created_at: { type: 'string', description: 'Order creation time' },
  },
  example: {
    command: 'agenzo-merchant-cli ride-elife get --order-id EL-20260527-1023456',
    output_summary:
      'Returns current status and driver/vehicle info. Terminal statuses: At destination, Cancelled, Rejected, Customer no show, Driver no show.',
  },
  polling: {
    recommended_interval_seconds: DEFAULT_WATCH_INTERVAL_SECONDS,
    terminal_statuses: [...TERMINAL_STATUSES],
    in_progress_statuses: ['Pending', 'Accepted', 'On my way', 'Waiting', 'On board'],
    field_availability: {
      driver: "Populated from status 'Accepted' onwards (after a driver is dispatched). Null in 'Pending'.",
      vehicle: "Populated from status 'Accepted' onwards. Null in 'Pending'.",
    },
  },
  error_recovery: {
    VEHICLE_UNAVAILABLE: 'Order not found. Verify --order-id is the ride_id from book. Do NOT retry.',
    BOOKING_FAILED: 'Transient elife error. Retry once after 5s.',
  },
};

/** `ride-elife cancel` schema (§4.4.1.3 cancel schema). Write op (W/Y). */
export const cancelSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: NOUN,
  verb: 'cancel',
  description: 'Cancel a ride order by id (a cancellation fee may apply depending on ride status)',
  flags: {
    'order-id': { type: 'string', required: true, description: 'The numeric ride_id (e.g. 4112961) to cancel — use the `ride_id` field from book/list-orders responses, NOT the rio_... order_id' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Unique key (1-128 chars [A-Za-z0-9_-]) forwarded verbatim as the Idempotency-Key header; never auto-generated',
    },
  },
  response: {
    ride_id: { type: 'string|int', description: 'Cancelled ride id' },
    ride_stat: { type: 'string', description: "Status after cancellation (typically 'Cancelled')" },
    cancellation: {
      type: 'object|null',
      description: 'Cancellation details',
      properties: {
        cancellation_fee: { type: 'float', description: 'Fee charged for cancellation' },
        reversal_amount: { type: 'float', description: 'Amount reversed/refunded' },
        currency: { type: 'string', description: 'ISO 4217 currency code' },
      },
    },
    refund_amount: { type: 'float', description: 'Amount credited back to the settlement balance (paid − cancellation_fee)' },
  },
  example: {
    command: 'agenzo-merchant-cli ride-elife cancel --order-id EL-20260527-1023456 --idempotency-key cancel-456',
    output_summary: 'Returns cancellation fee and refund amount.',
  },
  error_recovery: {
    CANCELLATION_NOT_ALLOWED: 'The ride is in a non-cancellable state. Do NOT retry; query status with `ride-elife get`.',
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Supply --idempotency-key (1-128 chars [A-Za-z0-9_-]); the CLI never generates one under --yes.',
  },
};

/** `ride-elife list-orders` schema (§4.4.1.3 list-orders schema). Read-only. */
export const listOrdersSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: NOUN,
  verb: 'list-orders',
  description: 'List previously placed ride orders with optional filters and pagination',
  flags: {
    status: { type: 'string', required: false, description: 'Filter by ride status (case-sensitive server casing)' },
    'order-type': { type: 'string', required: false, description: 'Filter by order type (e.g. realtime / airport)' },
    page: { type: 'int', required: false, default: 1, description: 'Page number', constraints: '>= 1' },
    'page-size': { type: 'int', required: false, default: 20, description: 'Items per page', constraints: '>= 1' },
  },
  response: {
    orders: {
      type: 'array',
      description: 'List of ride orders (slim list-item shape)',
      items: {
        order_id: { type: 'string', description: 'Internal order id' },
        ride_id: { type: 'string', description: 'Ride id (same as ride_id from book)' },
        status: { type: 'string', description: 'Current ride status' },
        vehicle_class: { type: 'string', description: 'Vehicle class' },
        is_scheduled: { type: 'bool', description: 'true = scheduled/airport, false = realtime' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime; empty for realtime orders' },
        price_amount: { type: 'float|null', description: 'Price in decimal currency units (NOT cents)' },
        final_amount: { type: 'float|null', description: 'Final settled amount' },
        price_currency: { type: 'string', description: 'ISO 4217 currency code' },
        payment_status: { type: 'string', description: 'Payment status' },
        final_settlement_status: { type: 'string', description: 'pending / settled / no_adjustment / settlement_pending / not_applicable' },
        cancellation_fee: { type: 'float|null', description: 'Cancellation fee for cancelled orders; null otherwise' },
        provider: { type: 'string', description: 'Service provider (elife)' },
        created_at: { type: 'string|null', description: 'Order creation time (ISO 8601)' },
        updated_at: { type: 'string|null', description: 'Last update time (ISO 8601)' },
      },
    },
    total: { type: 'int', description: 'Total matching orders' },
    page: { type: 'int', description: 'Current page' },
    page_size: { type: 'int', description: 'Items per page' },
  },
  example: {
    command: 'agenzo-merchant-cli ride-elife list-orders --status Pending --page 1 --page-size 10',
    output_summary: 'Returns a paginated list of ride orders with status and amount info.',
  },
  error_recovery: {
    INTERNAL_ERROR: 'Transient backend error. Retry once after a short delay.',
    PARAM_INVALID: 'Ensure --page / --page-size are positive integers, then retry.',
  },
};

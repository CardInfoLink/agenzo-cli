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
/** Hotel noun (command group) — the `hotel-redaug/*` verbs share this. */
export const HOTEL_NOUN = 'hotel-redaug';

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

/**
 * Polling guidance — status-query verbs (`get`, `get-checkout`) carry this block.
 *
 * `terminal_statuses` / `in_progress_statuses` are `Array<string | number>`
 * because hotel `get` keys off the INTEGER `order_status_code` set (`[3,4,5]` /
 * `[2]`), while ride `get` and hotel `get-checkout` use STRING statuses. The
 * widened element type keeps both valid in the same shared interface.
 */
export interface PollingSchema {
  recommended_interval_seconds: number;
  terminal_statuses: Array<string | number>;
  in_progress_statuses: Array<string | number>;
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
    'passenger-name': { type: 'string', required: false, description: 'Lead passenger full name' },
    'passenger-phone': { type: 'string', required: false, description: 'Passenger phone in E.164 format (e.g. +14155551234)' },
    'passenger-count': { type: 'int', required: false, description: 'Number of passengers' },
    'luggage-count': { type: 'int', required: false, description: 'Number of luggage items' },
    'passenger-email': { type: 'string', required: false, description: 'Passenger email address' },
    'children-count': { type: 'int', required: false, description: 'Number of children' },
    'infant-count': { type: 'int', required: false, description: 'Number of infants (passenger breakdown; affects seat pricing)' },
    'toddler-count': { type: 'int', required: false, description: 'Number of toddlers (passenger breakdown; affects seat pricing)' },
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

// ============================================================
// Hotel-redaug verb schemas
// ============================================================
//
// Flags / response are kept aligned with each command's ACTUAL flags
// (requirements 2.1 / 3.1 / 4.1 / 5.1 / 6.1 / 7.1 / 8.1 / 9.1) and the live
// response types in `types/hotel.ts` (NOT the capability schema where they
// diverge). Three deliberate reconciliations vs the capability schema:
//   - `order_status` is the std STRING on the wire; `get` also carries the
//     integer `order_status_code` (2/3/4/5). There is NO `order_status_std`.
//   - `cancel` models both the confirmed and accepted-but-pending shapes.
//   - `checkout` returns `{ order_id, task_order_code, apply_status,
//     checkout_status }`.
// Amounts are decimal currency units paired with a currency code (never minor
// units). `error_recovery` guidance is taken from the capability schema's
// `error_recovery[code].agent_action`, keyed on the REAL wire codes
// (`HOTEL_ORDER_NOT_FOUND` / `CHECKOUT_TASK_NOT_FOUND`, not the agent-facing
// `ORDER_NOT_FOUND` / `TASK_NOT_FOUND` aliases).
//
// `--api-key`, `--yes` and `--format` are cross-cutting flags resolved by the
// program/top-level handler; like the ride-elife schemas, they are intentionally
// omitted from the per-verb `flags` block (which declares only domain flags).

/** `hotel-redaug search` schema. Read-only, supports both location branches. */
export const hotelSearchSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'search',
  description:
    'Search hotels near a coordinate OR within a destination for the given stay dates. Two location branches: --destination-id (from find-destination) XOR --lat/--lng (geocoded by the Agent backend). Exactly one branch must be supplied',
  flags: {
    'destination-id': { type: 'string', required: 'conditional', description: 'Destination ID from find-destination (alternative to --lat/--lng)', constraints: 'Exactly one location branch: --destination-id XOR (--lat + --lng)' },
    lat: { type: 'float', required: 'conditional', description: 'Latitude of the search center (geocoded by the Agent backend, not by the CLI)', constraints: '-90 to 90; requires --lng; mutually exclusive with --destination-id' },
    lng: { type: 'float', required: 'conditional', description: 'Longitude of the search center (geocoded by the Agent backend, not by the CLI)', constraints: '-180 to 180; requires --lat; mutually exclusive with --destination-id' },
    distance: { type: 'int', required: false, default: 20, description: 'Search radius in kilometers', constraints: 'Agent infers from phrasing — small (2-5) for "right next to a spot", larger (15-30) for a whole city. Do NOT ask the user for a number' },
    'check-in': { type: 'string', required: true, description: 'Check-in date', constraints: 'YYYY-MM-DD, today or later' },
    'check-out': { type: 'string', required: true, description: 'Check-out date', constraints: 'YYYY-MM-DD, strictly after check-in' },
    adults: { type: 'int', required: false, default: 2, description: 'Number of adults', constraints: '1-9 per room' },
    children: { type: 'int', required: false, default: 0, description: 'Number of children' },
    'room-num': { type: 'int', required: false, default: 1, description: 'Number of rooms requested' },
    star: { type: 'int', required: false, description: 'Minimum hotel star rating filter', constraints: 'Enum 3 / 4 / 5' },
    keyword: { type: 'string', required: false, description: 'Optional hotel name keyword to narrow results' },
    'price-min': { type: 'float', required: false, description: 'Minimum price filter' },
    'price-max': { type: 'float', required: false, description: 'Maximum price filter' },
    'sort-by': { type: 'string', required: false, description: 'Sort field' },
    page: { type: 'int', required: false, default: 1, description: 'Page number', constraints: '>= 1' },
    'page-size': { type: 'int', required: false, default: 10, description: 'Results per page', constraints: '>= 1' },
    'hotel-facility-codes': { type: 'string', required: false, description: 'Hotel facility codes (comma-separated or JSON array, from hotel-filters)' },
    'room-facility-codes': { type: 'string', required: false, description: 'Room facility codes (comma-separated or JSON array, from hotel-filters)' },
    'hotel-brand-codes': { type: 'string', required: false, description: 'Hotel brand codes (comma-separated or JSON array, from hotel-filters)' },
    'plate-codes': { type: 'string', required: false, description: 'Plate codes (comma-separated or JSON array, from hotel-filters)' },
    'hotel-label-ids': { type: 'string', required: false, description: 'Hotel label IDs (comma-separated or JSON array, from hotel-filters)' },
    'hotel-sub-category-ids': { type: 'string', required: false, description: 'Hotel sub-category IDs (comma-separated or JSON array, from hotel-filters)' },
  },
  response: {
    hotels: {
      type: 'array',
      description: 'Matching hotels for the location and dates. Empty when nothing was found (rendered as a successful empty result, not an error).',
      items: {
        hotel_id: { type: 'string|int', description: 'Opaque hotel identifier. Pass verbatim to quote --hotel-id. Do NOT interpret.' },
        hotel_name: { type: 'string', description: 'Hotel name.' },
        star: { type: 'int|null', description: 'Star rating.' },
        address: { type: 'string|null', description: 'Hotel address.' },
        distance_km: { type: 'float|null', description: 'Approximate distance from the search center, in km.' },
        city_name: { type: 'string|null', description: 'City name.' },
        district_name: { type: 'string|null', description: 'District name.' },
        business_name: { type: 'string|null', description: 'Business area name.' },
        score: { type: 'float|null', description: 'Hotel score/rating.' },
        main_image: { type: 'string|null', description: 'Main hotel image URL.' },
        lowest_price: {
          type: 'object|null',
          description: 'Indicative nightly starting price (not the bookable total — get the real price from quote).',
          properties: {
            amount: { type: 'float', description: 'Starting price in DECIMAL units (NOT cents).' },
            currency: { type: 'string', description: 'ISO 4217 currency code.' },
          },
        },
      },
    },
  },
  example: {
    command:
      'agenzo-merchant-cli hotel-redaug search --destination-id D12345 --check-in 2026-07-04 --check-out 2026-07-05 --adults 2',
    output_summary: 'Returns hotels[] for the location. Pick one and use hotels[].hotel_id in hotel-redaug quote. Alternatively use --lat/--lng instead of --destination-id.',
  },
  error_recovery: {
    NO_AVAILABILITY: 'No hotels near this coordinate for these dates. Widen --distance, try different dates, or have the Agent backend geocode a nearby area. As a last resort try another category=hotel service (see cross_service_recovery).',
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after ~2s backoff. Otherwise surface to user.',
  },
};

/** `hotel-redaug quote` schema. Read-only. */
export const hotelQuoteSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'quote',
  description:
    'Get real-time room types and bookable rates for one hotel and stay. Returns rates each carrying an opaque product_token and per-night price_items that must be passed verbatim to create-order. Run immediately before create-order — availability and prices change in real time',
  flags: {
    'hotel-id': { type: 'string', required: true, description: 'Hotel chosen from search results (search.response.hotels[].hotel_id)' },
    'check-in': { type: 'string', required: true, description: 'Check-in date (match search)', constraints: 'YYYY-MM-DD' },
    'check-out': { type: 'string', required: true, description: 'Check-out date (match search)', constraints: 'YYYY-MM-DD, strictly after check-in' },
    adults: { type: 'int', required: false, default: 2, description: 'Adults per room (match search)' },
    children: { type: 'int', required: false, default: 0, description: 'Children per room (match search)' },
    'room-num': { type: 'int', required: false, default: 1, description: 'Number of rooms (match search)' },
    nationality: { type: 'string', required: false, default: 'CN', description: 'Guest nationality (ISO country code). Affects rate eligibility for some hotels' },
  },
  response: {
    rates: {
      type: 'array',
      description: 'Bookable room+rate options. Empty when the hotel has no rooms for these dates (treat as NO_AVAILABILITY: re-quote another hotel or change dates).',
      items: {
        product_token: { type: 'string', description: 'Opaque token packing room/rate/supply identifiers. Pass verbatim to create-order --product-token. Do NOT interpret or reuse across quotes.' },
        room_name: { type: 'string', description: 'Room type name.' },
        rate_plan_name: { type: 'string|null', description: "Rate plan name (e.g. 'Breakfast included, free cancellation')." },
        breakfast: { type: 'int|null', description: 'Breakfast enum for the rate (-1=bed breakfast, 0=no breakfast, 1+=N breakfasts). Display only.' },
        free_cancellation: { type: 'bool|null', description: 'Whether this rate is currently in a free-cancellation window. Prefer when the user wants flexibility.' },
        total_price: {
          type: 'object',
          description: 'Total bookable price for the whole stay and room count.',
          properties: {
            amount: { type: 'float', description: 'Total price in DECIMAL units. Pass verbatim to create-order --total-amount.' },
            currency: { type: 'string', description: 'ISO 4217 currency code. Pass to create-order --currency.' },
          },
        },
        price_items: {
          type: 'array',
          description: 'Per-night price breakdown. Pass this array verbatim to create-order --price-items.',
          items: {
            sale_date: { type: 'string', description: 'Night date YYYY-MM-DD.' },
            sale_price: { type: 'float', description: 'Price for that night in DECIMAL units.' },
            breakfast_num: { type: 'int', description: 'Breakfast enum for that night (-1=bed breakfast, 0=no breakfast, 1+=N). Copy verbatim into create-order; never alter.' },
          },
        },
      },
    },
  },
  example: {
    command:
      'agenzo-merchant-cli hotel-redaug quote --hotel-id 10583772 --check-in 2026-08-20 --check-out 2026-08-21 --adults 2',
    output_summary: 'Returns rates[]. Use rates[].product_token, total_price.amount/currency and price_items[] in hotel-redaug create-order.',
  },
  error_recovery: {
    NO_AVAILABILITY: 'This hotel has no bookable rooms for these dates (upstream roomItems empty). Re-quote a different hotel from the search result, or re-search with other dates. Do NOT retry the same hotel/dates.',
    PRICE_CHANGED: 'Rates shifted since search. Use the prices returned here; do not reuse search lowest_price. No action other than informing the user if materially higher.',
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after ~2s backoff.',
  },
};

/** `hotel-redaug create-order` schema. Write op (W/Y) — lock inventory, no charge. */
export const hotelCreateOrderSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'create-order',
  description:
    'Create a hotel order WITHOUT charging any account (re-check availability + createOrder upstream), using a product_token and price_items from a recent quote. The order enters AWAITING_PAYMENT — no money is moved until pay-order. check-in/check-out, guest counts, total-amount and price-items must match the quote',
  flags: {
    'product-token': { type: 'string', required: true, description: 'Chosen rate token from quote (quote.response.rates[].product_token). Pass verbatim' },
    'total-amount': { type: 'float', required: true, description: 'Total price for the stay (quote.response.rates[].total_price.amount)', constraints: 'DECIMAL units (NOT cents), 0.01–999999999.99. Must equal the chosen rate total_price.amount' },
    currency: { type: 'string', required: true, description: 'ISO 4217 currency code from the chosen rate (quote.response.rates[].total_price.currency)', constraints: 'Exactly 3 uppercase letters' },
    'price-items': { type: 'string', required: true, description: 'Per-night price breakdown from quote, copied verbatim (including breakfast_num)', constraints: 'JSON array of {sale_date, sale_price, breakfast_num}; copy breakfast_num verbatim from quote (-1/0/1+ are distinct breakfast products, never alter); else PARAM_INVALID' },
    'check-in': { type: 'string', required: true, description: 'Check-in date (match quote)', constraints: 'YYYY-MM-DD' },
    'check-out': { type: 'string', required: true, description: 'Check-out date (match quote)', constraints: 'YYYY-MM-DD, strictly after check-in' },
    'room-num': { type: 'int', required: false, default: 1, description: 'Number of rooms (match quote)' },
    adults: { type: 'int', required: false, default: 2, description: 'Adults per room (match quote)', constraints: '1-20' },
    children: { type: 'int', required: false, default: 0, description: 'Children per room (match quote)', constraints: '0-10' },
    nationality: { type: 'string', required: false, default: 'CN', description: 'Guest nationality (match quote)' },
    'guest-name': { type: 'string', required: true, description: 'Primary guest name', constraints: 'Use the name as the user gives it. If a supplier returns NAME_FORMAT_INVALID, re-collect in Latin letters and retry' },
    'contact-name': { type: 'string', required: true, description: 'Booking contact name (may equal guest-name)' },
    'contact-phone': { type: 'string', required: true, description: 'Booking contact phone number', constraints: 'Digits; collect country code separately in --contact-country-code' },
    'contact-country-code': { type: 'string', required: false, default: '86', description: "Phone country calling code without '+'" },
    'contact-email': { type: 'string', required: false, description: 'Booking contact email' },
    'arrive-time': { type: 'string', required: false, description: 'Expected arrival time', constraints: 'HH:mm, hotel local time' },
    'special-requests': { type: 'string', required: false, description: 'Free-text special requests (non-binding)' },
    'payment-token-id': {
      type: 'string',
      required: false,
      description: 'UPI Agent Pay only: payment token id from an already-completed UnionPay network-token capture (funds already charged). When set, the platform skips EVO preauth/capture and only locks the order.',
    },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Unique key forwarded verbatim as the Idempotency-Key header; never auto-generated. Derive from business intent (e.g. hash(user_id + product_token + check_in)) and reuse the SAME key when retrying the same order creation',
      constraints: '1-128 chars [A-Za-z0-9_-]',
    },
  },
  response: {
    order_id: { type: 'string', description: 'Our order reference (coOrderCode). Use as --order-id in pay-order / get / cancel.' },
    fc_order_code: { type: 'string', description: 'Supplier order reference. Needed as --fc-order-code in cancel and checkout.' },
    total_amount: { type: 'float', description: 'Amount to be paid in pay-order (DECIMAL units). The order is locked in AWAITING_PAYMENT — no charge has been made.' },
    currency: { type: 'string', description: 'ISO 4217 currency code for the payment.' },
  },
  example: {
    command:
      `agenzo-merchant-cli hotel-redaug create-order --product-token <tok> --total-amount 10.00 --currency CNY --price-items '[{"sale_date":"2026-08-20","sale_price":10.00,"breakfast_num":0}]' --check-in 2026-08-20 --check-out 2026-08-21 --adults 2 --guest-name "Zhang San" --contact-name "Zhang San" --contact-phone 13800138000 --idempotency-key create-h1n2`,
    output_summary: 'Returns {order_id, fc_order_code, total_amount, currency}. The order is AWAITING_PAYMENT (no charge). Use order_id as --order-id in pay-order to settle.',
  },
  error_recovery: {
    NO_AVAILABILITY: 'Availability vanished between quote and create-order. Re-quote the same hotel; if still empty, quote another hotel or change dates. Use a NEW idempotency-key for the new product_token.',
    PRICE_CHANGED: 'The price/price_items no longer match upstream. Re-quote to get fresh total_price and price_items, confirm the new price with the user, then create-order with the new values and a NEW idempotency-key.',
    NAME_FORMAT_INVALID: 'The supplier requires the guest name in a specific format (commonly Latin first/last name for international properties). Re-collect guest-name in Latin letters and retry with the SAME idempotency-key.',
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Add a unique --idempotency-key derived from business intent and retry.',
    PARAM_IDEMPOTENCY_KEY_CONFLICT: 'The same idempotency-key was used with different parameters. Retry with the original parameters, or generate a NEW key for the new parameters.',
    UPSTREAM_ERROR: 'Transient upstream error during checkBooking or createOrder. Retry once after ~2s backoff with the SAME idempotency-key.',
  },
};

/** `hotel-redaug pay-order` schema. Write op (W/Y) — settle a created order. */
export const hotelPayOrderSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'pay-order',
  description:
    'Settle an existing AWAITING_PAYMENT order created by create-order. Takes only --order-id; the billing path is decided server-side by the order billing_mode. monthly_settlement deducts from the developer credit account then confirms with the supplier; pay_per_call verifies the user EVO payment — the EVO merchantTransID IS the order_id (the user pays via EVO under the order_id), so the platform queries EVO for that order_id and requires an exact amount/currency match before confirming (the response settlement_path is then "pay_per_call"). On success the order becomes PAID. Supports --watch to poll on PAYMENT_NOT_COMPLETED until PAID',
  flags: {
    'order-id': { type: 'string', required: true, description: 'Order to settle (create-order.response.order_id). For pay_per_call this is also the EVO merchantTransID the user paid under.' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Unique key forwarded verbatim as the Idempotency-Key header; never auto-generated. Derive from business intent (e.g. hash(order_id + attempt)) and reuse the SAME key when retrying the same payment',
      constraints: '1-128 chars [A-Za-z0-9_-]',
    },
    watch: { type: 'bool', required: false, default: false, description: 'Poll automatically on PAYMENT_NOT_COMPLETED until PAID or timeout. Each iteration emits one NDJSON line' },
    'watch-interval': { type: 'int', required: false, default: 5, description: 'Seconds between poll attempts in --watch mode' },
    'watch-timeout': { type: 'int', required: false, default: 300, description: 'Total seconds before giving up in --watch mode' },
  },
  response: {
    order_id: { type: 'string', description: 'Order reference.' },
    settlement_path: { type: 'string', description: "Which billing path was used: 'monthly_settlement' or 'pay_per_call' (same tokens as billing_mode)." },
    amount: { type: 'float', description: 'Settled amount in DECIMAL units.' },
    currency: { type: 'string', description: 'ISO 4217 currency code of the settlement.' },
    pay_status: { type: 'int', description: 'Upstream pay status (1 = paid). The order internal status is now PAID.' },
    settled_at: { type: 'string', description: 'ISO 8601 settlement timestamp. On idempotent replay, the original first settled_at is returned unchanged.' },
  },
  example: {
    command:
      'agenzo-merchant-cli hotel-redaug pay-order --order-id hho_01KWC63Z5CD6CKBM33Q7SC2ZDT --idempotency-key pay-h1n2',
    output_summary: 'Settlement path is chosen server-side by billing_mode. monthly_settlement: deducts from the credit account, confirms with the supplier. Returns {order_id, settlement_path:"monthly_settlement", amount, currency, pay_status:1, settled_at}. Order becomes PAID. For pay_per_call the user must have already paid via EVO using the order_id as the merchantTransID; the same command settles it (settlement_path:"pay_per_call").',
  },
  error_recovery: {
    PAYMENT_NOT_COMPLETED: 'pay_per_call only: EVO has not yet confirmed the payment for this order_id. Retry with the SAME idempotency-key after a delay, or use --watch to poll automatically until PAID.',
    PAYMENT_NOT_FOUND: 'No EVO transaction found for this order_id. Confirm the user paid via EVO using the order_id as the merchantTransID; do NOT retry blindly.',
    PAYMENT_AMOUNT_MISMATCH: 'The EVO-confirmed amount/currency does not match the order. The user must pay the exact order amount in the exact currency under the order_id. Do NOT retry until corrected.',
    PAYMENT_QUERY_FAILED: 'EVO gateway query failed (transport/timeout). Retry once after ~5s with the SAME idempotency-key.',
    BILLING_MODE_MISMATCH: 'The order billing_mode is not a recognized settlement mode (only monthly_settlement and pay_per_call are valid). Check the developer billing_mode; do NOT retry blindly.',
    INVALID_ORDER_STATE: 'The order is not in AWAITING_PAYMENT (it may already be PAID or CANCELLED). Check status via get; do NOT retry pay-order.',
    ORDER_NOT_FOUND: 'No order for this --order-id. Verify it is the order_id returned by create-order. Do NOT retry.',
    ACCOUNT_INSUFFICIENT_BALANCE: 'Settlement credit is insufficient (check via admin-cli accounts get). Direct the user to top up offline.',
    ACCOUNT_NOT_FOUND: 'Developer has no settlement account. Direct the user to complete contract signing.',
    ACCOUNT_SUSPENDED: 'The settlement account is suspended. Direct the user to contact support; do NOT retry.',
    PAYORDER_FAILED: 'Upstream payOrder failed after a successful deduction; the deduction was reversed and the order stays AWAITING_PAYMENT. Retry with the SAME idempotency-key after a delay.',
    PAYORDER_FAILED_AFTER_PAYMENT: 'EVO payment confirmed but upstream payOrder failed. The order is recoverable (the EVO payment under the order_id is preserved). Contact support for reconciliation; do NOT retry automatically.',
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Add a unique --idempotency-key and retry.',
    PARAM_IDEMPOTENCY_KEY_CONFLICT: 'Same idempotency-key used with different parameters. Use the original parameters, or generate a NEW key.',
  },
};

/** `hotel-redaug get` schema. Read-only, supports `--watch`. Long-running. */
export const hotelGetSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'get',
  description:
    'Query a hotel order status by id; with --watch, poll until a terminal status. Confirmation from the property is asynchronous, so order_status is usually PROCESSING (2) immediately after book — poll until CONFIRMED (3)',
  flags: {
    'order-id': { type: 'string', required: true, description: 'Our order reference (coOrderCode) returned by book (book.response.order_id)' },
    watch: { type: 'bool', required: false, default: false, description: 'Poll until a terminal status, emitting one NDJSON line per update' },
    'watch-interval': { type: 'int', required: false, default: 5, description: 'Seconds between polls when --watch is set' },
    'watch-timeout': { type: 'int', required: false, default: 600, description: 'Max seconds to poll before giving up' },
  },
  response: {
    order_id: { type: 'string', description: 'Our order reference.' },
    fc_order_code: { type: 'string', description: 'Supplier order reference.' },
    order_status: { type: 'string', description: 'Std STRING: PROCESSING | CONFIRMED | CANCELLED | COMPLETED | INIT. There is no order_status_std field.' },
    order_status_code: { type: 'int', description: '2 = Processing, 3 = Confirmed, 4 = Cancelled, 5 = Completed. Provider path only; absent on the local-cache fallback.' },
    channel_state: { type: 'string|null', description: "Channel-level state (e.g. 'paid' = settled)." },
    hotel_confirm_no: { type: 'string|null', description: 'Property confirmation number. Populated once order_status reaches CONFIRMED (3); null while PROCESSING (2).' },
    hotel_name: { type: 'string|null', description: 'Hotel name.' },
    room_name: { type: 'string|null', description: 'Booked room type.' },
    check_in: { type: 'string|null', description: 'Check-in date YYYY-MM-DD.' },
    check_out: { type: 'string|null', description: 'Check-out date YYYY-MM-DD.' },
    total_amount: { type: 'float|null', description: 'Total amount in DECIMAL units.' },
    source: { type: 'string', description: "'provider' (live upstream, carries order_status_code) or 'local_cache' (fallback, string status only)." },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug get --order-id E2E1750000000',
    output_summary: 'Returns order_status (string) + order_status_code (int). Poll every 5s until CONFIRMED (3); hotel_confirm_no appears once confirmed.',
  },
  polling: {
    recommended_interval_seconds: 5,
    terminal_statuses: [3, 4, 5],
    in_progress_statuses: [2],
    field_availability: {
      hotel_confirm_no: 'Populated only after order_status reaches CONFIRMED (3). Null while PROCESSING (2).',
    },
  },
  error_recovery: {
    HOTEL_ORDER_NOT_FOUND: 'No order for this --order-id. Verify it is the order_id returned by book. Do NOT retry.',
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after 5s; if still failing, surface to user.',
  },
};

/** `hotel-redaug cancel` schema. Write op (W/Y) — acknowledgement is not proof. */
export const hotelCancelSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'cancel',
  description:
    'Cancel an entire hotel order within the cancellation policy (a cancellation fee may apply). Returns synchronously, but a successful call is acceptance only, NOT proof: poll get until order_status=CANCELLED (4). For partial-night or out-of-policy cancellation, use checkout instead',
  flags: {
    'order-id': { type: 'string', required: true, description: 'Our order reference (coOrderCode) to cancel (book.response.order_id)' },
    'fc-order-code': { type: 'string', required: true, description: 'Supplier order reference (book.response.fc_order_code)' },
    reason: { type: 'string', required: false, description: 'Cancellation reason' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Unique key forwarded verbatim as the Idempotency-Key header; never auto-generated. Reuse the SAME key when retrying the same cancellation',
      constraints: '1-128 chars [A-Za-z0-9_-]',
    },
  },
  response: {
    order_id: { type: 'string', description: 'Cancelled order reference.' },
    order_status: { type: 'string', description: "Status after the cancel request. Acceptance is NOT proof — poll get until 'CANCELLED' (order_status_code 4)." },
    cancellation: {
      type: 'object|null',
      description: 'Confirmed-cancellation details (confirmed shape).',
      properties: {
        cancellation_fee: { type: 'float', description: 'Fee charged for cancellation, in DECIMAL units.' },
        reversal_amount: { type: 'float', description: 'Amount reversed/refunded, in DECIMAL units.' },
        currency: { type: 'string', description: 'ISO 4217 currency code.' },
      },
    },
    cancellation_fee: { type: 'float|null', description: 'Fee charged for cancellation (confirmed shape), in DECIMAL units.' },
    refund_amount: { type: 'float', description: 'Amount credited back to the settlement balance (paid - cancellation_fee), in DECIMAL units.' },
    cancel_status: { type: 'string|absent', description: "'cancel_pending' when accepted upstream but not yet observed as CANCELLED (accepted-but-pending shape)." },
    cancel_result: { type: 'unknown|absent', description: 'Upstream cancel acknowledgement (pending shape). NOT proof of cancellation — confirm via get.' },
  },
  example: {
    command:
      'agenzo-merchant-cli hotel-redaug cancel --order-id E2E1750000000 --fc-order-code FC1750000000 --idempotency-key cancel-h1n2',
    output_summary: 'Returns the cancellation acknowledgement and any fee/refund. Then poll get until order_status=CANCELLED (4) to confirm.',
  },
  error_recovery: {
    CANCELLATION_NOT_ALLOWED: 'The order is outside its free/allowed cancellation window or already terminal. Do NOT retry cancel. If the user still wants out (e.g. drop some nights or request a waiver), use checkout instead.',
    ALREADY_CANCELLED: 'Order is already cancelled (order_status=4). Treat as success; confirm via get.',
    HOTEL_ORDER_NOT_FOUND: 'Verify --order-id / --fc-order-code from the book response. Do NOT retry.',
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after 5s with the SAME idempotency-key, then poll get to check whether the cancellation actually took effect.',
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Add a unique --idempotency-key derived from business intent and retry.',
    PARAM_IDEMPOTENCY_KEY_CONFLICT: 'The same idempotency-key was used with different parameters. Retry with the original parameters, or generate a NEW key for the new parameters.',
  },
};

/** `hotel-redaug checkout` schema. Write op (W/Y) — async application. */
export const hotelCheckoutSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'checkout',
  description:
    'Request a partial check-out or an out-of-policy cancellation (drop some nights, or cancel after the free window so the property must approve). This is an APPLICATION: it returns a task_order_code synchronously, then the supplier decides asynchronously — poll get-checkout. Use cancel for a simple whole-order in-policy cancellation',
  flags: {
    'order-id': { type: 'string', required: true, description: 'Our order reference (coOrderCode) for the URL path (book.response.order_id)' },
    'fc-order-code': { type: 'string', required: true, description: 'Supplier order reference of the booking to change (book.response.fc_order_code)' },
    reason: { type: 'string', required: true, description: 'Why the partial check-out / out-of-policy cancellation is requested' },
    'checkout-rooms': {
      type: 'string',
      required: true,
      description: 'Which booked rooms to check out of, taken from the book response (book.response.rooms[]). room_index and guest_name come verbatim from book — do NOT ask the user for them',
      constraints: 'JSON array of {room_index, guest_name, cancel_check_in_date}; else PARAM_INVALID. cancel_check_in_date is the check-in date of the night(s) being dropped (YYYY-MM-DD)',
    },
    'refund-type': { type: 'int', required: false, default: 1, description: 'Requested refund handling (upstream refund-type code; default to the standard refund flow when unsure)' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Unique key forwarded verbatim as the Idempotency-Key header; never auto-generated. Reuse the SAME key when retrying the same application',
      constraints: '1-128 chars [A-Za-z0-9_-]',
    },
  },
  response: {
    order_id: { type: 'string', description: 'Our order reference (echoes the path order_id).' },
    task_order_code: { type: 'string', description: 'Check-out application id. Poll get-checkout --task-order-code to track approval and refund.' },
    apply_status: { type: 'string|null', description: 'Initial application status (e.g. submitted / pending).' },
    checkout_status: { type: 'string|absent', description: "'checkout_pending' — async; poll get-checkout for the outcome." },
  },
  example: {
    command:
      `agenzo-merchant-cli hotel-redaug checkout --order-id E2E1750000000 --fc-order-code FC1750000000 --reason "guest leaving early" --checkout-rooms '[{"room_index":"1","guest_name":"San Zhang","cancel_check_in_date":"2026-07-05"}]' --idempotency-key checkout-h1n2`,
    output_summary: 'Returns task_order_code. Poll hotel-redaug get-checkout --task-order-code <code> until the application is approved/rejected/refunded.',
  },
  error_recovery: {
    CHECKOUT_NOT_ALLOWED: 'The order state does not permit a check-out application (e.g. not yet confirmed, or already completed). Surface to user; do NOT retry.',
    HOTEL_ORDER_NOT_FOUND: 'Verify --order-id / --fc-order-code from the book response. Do NOT retry.',
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after 5s with the SAME idempotency-key.',
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Add a unique --idempotency-key derived from business intent and retry.',
    PARAM_IDEMPOTENCY_KEY_CONFLICT: 'The same idempotency-key was used with different parameters. Retry with the original parameters, or generate a NEW key for the new parameters.',
  },
};

/** `hotel-redaug get-checkout` schema. Read-only, supports `--watch`. Long-running. */
export const hotelGetCheckoutSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'get-checkout',
  description:
    'Poll the status and refund outcome of a check-out application created by checkout. The supplier decides asynchronously; with --watch, keep polling until a terminal refund_status',
  flags: {
    'task-order-code': { type: 'string', required: true, description: 'Check-out application id from checkout (checkout.response.task_order_code)' },
    watch: { type: 'bool', required: false, default: false, description: 'Poll until a terminal status, emitting one NDJSON line per update' },
    'watch-interval': { type: 'int', required: false, default: 10, description: 'Seconds between polls when --watch is set' },
    'watch-timeout': { type: 'int', required: false, default: 600, description: 'Max seconds to poll before giving up' },
  },
  response: {
    task_order_code: { type: 'string', description: 'Check-out application id.' },
    refund_status: { type: 'string', description: 'Application/refund status: pending | approved | rejected | refunded.' },
    refund: {
      type: 'object|null',
      description: 'Final refund once approved. Populated only once refund_status is approved or refunded.',
      properties: {
        amount: { type: 'float', description: 'Refunded amount in DECIMAL units.' },
        currency: { type: 'string', description: 'ISO 4217 currency code.' },
      },
    },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug get-checkout --task-order-code TASK1750000000',
    output_summary: 'Returns refund_status. Poll every 10s until approved/rejected/refunded; refund appears once approved.',
  },
  polling: {
    recommended_interval_seconds: 10,
    terminal_statuses: ['approved', 'rejected', 'refunded'],
    in_progress_statuses: ['pending'],
    field_availability: {
      refund: 'Populated only once refund_status is approved or refunded.',
    },
  },
  error_recovery: {
    CHECKOUT_TASK_NOT_FOUND: 'Verify --task-order-code from the checkout response. Do NOT retry.',
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after 10s.',
  },
};

/** `hotel-redaug list-orders` schema. Read-only. */
export const hotelListOrdersSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'list-orders',
  description: 'List the developer\'s hotel orders with optional status filtering and pagination',
  flags: {
    status: { type: 'string', required: false, description: 'Filter by order status (e.g. PROCESSING / CONFIRMED / CANCELLED / COMPLETED). Omitted entirely when absent (all statuses)' },
    page: { type: 'int', required: false, default: 1, description: 'Page number', constraints: '>= 1' },
    'page-size': { type: 'int', required: false, default: 20, description: 'Items per page', constraints: '>= 1 (platform caps at 100 server-side)' },
  },
  response: {
    orders: {
      type: 'array',
      description: 'List of hotel orders (slim list-item shape).',
      items: {
        order_id: { type: 'string', description: 'Our order reference.' },
        fc_order_code: { type: 'string', description: 'Supplier order reference.' },
        status: { type: 'string', description: 'Current order status (string).' },
        provider: { type: 'string', description: "Service provider ('redaug')." },
        check_in: { type: 'string|null', description: 'Check-in date YYYY-MM-DD.' },
        check_out: { type: 'string|null', description: 'Check-out date YYYY-MM-DD.' },
        room_num: { type: 'int|null', description: 'Number of rooms booked.' },
        price_amount: { type: 'float|null', description: 'Total price in DECIMAL units (NOT cents).' },
        price_currency: { type: 'string', description: 'ISO 4217 currency code.' },
        payment_status: { type: 'string', description: "Payment status (e.g. 'ON_ACCOUNT')." },
        hotel_confirm_no: { type: 'string|null', description: 'Property confirmation number (once confirmed).' },
        cancellation_fee: { type: 'float|null', description: 'Cancellation fee for cancelled orders; null otherwise.' },
        refund_amount: { type: 'float|null', description: 'Amount refunded on cancellation/checkout; null otherwise.' },
        created_at: { type: 'string', description: 'Order creation time (ISO 8601).' },
        updated_at: { type: 'string', description: 'Last update time (ISO 8601).' },
      },
    },
    total: { type: 'int', description: 'Total matching orders.' },
    page: { type: 'int', description: 'Current page.' },
    page_size: { type: 'int', description: 'Items per page.' },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug list-orders --status CONFIRMED --page 1 --page-size 10',
    output_summary: 'Returns a paginated list of hotel orders with status, dates and amount info.',
  },
  error_recovery: {
    INTERNAL_ERROR: 'Transient backend error. Retry once after a short delay.',
    PARAM_INVALID: 'Ensure --page / --page-size are positive integers, then retry.',
  },
};

// ============================================================
// Hotel-redaug Addendum A verb schemas (4 new read-only verbs)
// ============================================================

/** `hotel-redaug find-destination` schema. Read-only. */
export const hotelFindDestinationSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'find-destination',
  description:
    'Search for a destination by keyword (city, landmark, airport, etc.). Returns a list of destinations whose destination_id can be passed to search --destination-id or hotel-filters --destination-id',
  flags: {
    keyword: { type: 'string', required: true, description: 'Destination search keyword (city name, landmark, airport code, etc.)' },
    'data-type': { type: 'string', required: false, description: 'Optional data type filter to narrow result categories' },
  },
  response: {
    destinations: {
      type: 'array',
      description: 'Matching destinations. Empty when nothing matches the keyword (rendered as a successful empty result, not an error).',
      items: {
        destination_id: { type: 'string|null', description: 'Opaque destination identifier. Pass to search --destination-id or hotel-filters --destination-id.' },
        type: { type: 'string|int|null', description: 'Destination type (city, landmark, airport, etc.).' },
        name: { type: 'string|null', description: 'Destination name.' },
        city_name: { type: 'string|null', description: 'City name.' },
        city_code: { type: 'string|null', description: 'City code.' },
        country_name: { type: 'string|null', description: 'Country name.' },
        lat: { type: 'float|null', description: 'Latitude (can also be used with search --lat).' },
        lng: { type: 'float|null', description: 'Longitude (can also be used with search --lng).' },
      },
    },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug find-destination --keyword "Shanghai"',
    output_summary: 'Returns destinations[]. Use destinations[].destination_id in search --destination-id or hotel-filters --destination-id.',
  },
  error_recovery: {
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after ~2s backoff.',
    PARAM_INVALID: 'Ensure --keyword is non-empty, then retry.',
  },
};

/** `hotel-redaug hotel-filters` schema. Read-only. */
export const hotelFiltersSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'hotel-filters',
  description:
    'Get available filter options (stars, brands, groups, labels, sub-categories, hotel/room facilities) for a location. Each item\'s code maps directly to the corresponding search filter flag (e.g. hotel_facilities[].code → search --hotel-facility-codes)',
  flags: {
    'destination-id': { type: 'string', required: 'conditional', description: 'Destination ID (alternative to --lat/--lng)', constraints: 'Exactly one location branch: --destination-id XOR (--lat + --lng)' },
    lat: { type: 'float', required: 'conditional', description: 'Latitude (-90 to 90, requires --lng)', constraints: '-90 to 90; mutually exclusive with --destination-id' },
    lng: { type: 'float', required: 'conditional', description: 'Longitude (-180 to 180, requires --lat)', constraints: '-180 to 180; mutually exclusive with --destination-id' },
    distance: { type: 'int', required: false, default: 20, description: 'Search radius in kilometers' },
  },
  response: {
    stars: { type: 'array', description: 'Star rating options [{code, name, count}]. code → search --star.' },
    brands: { type: 'array', description: 'Hotel brand options [{code, name, count}]. code → search --hotel-brand-codes.' },
    groups: { type: 'array', description: 'Hotel group options [{code, name, count}].' },
    labels: { type: 'array', description: 'Hotel label options [{code, name, count}]. code → search --hotel-label-ids.' },
    sub_categories: { type: 'array', description: 'Hotel sub-category options [{code, name, count}]. code → search --hotel-sub-category-ids.' },
    hotel_facilities: { type: 'array', description: 'Hotel facility options [{code, name, count, type}]. code → search --hotel-facility-codes.' },
    room_facilities: { type: 'array', description: 'Room facility options [{code, name, count, type}]. code → search --room-facility-codes.' },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug hotel-filters --destination-id D12345',
    output_summary: 'Returns filter groups. Use the code values in search filter flags (e.g. search --hotel-facility-codes code1,code2).',
  },
  error_recovery: {
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after ~2s backoff.',
    PARAM_INVALID: 'Supply exactly one location branch (--destination-id OR --lat/--lng). Coordinates must be within valid ranges.',
  },
};

/** `hotel-redaug list-cities` schema. Read-only. */
export const hotelListCitiesSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'list-cities',
  description:
    'List cities available for hotel booking in a given country. Each city provides a destination_id (for search --destination-id) and/or lat/lng coordinates (for search --lat/--lng)',
  flags: {
    country: { type: 'string', required: true, description: 'ISO country code (e.g. CN, US, TH)' },
  },
  response: {
    cities: {
      type: 'array',
      description: 'Cities for the country. Empty when no cities are available (rendered as success, not an error).',
      items: {
        city_code: { type: 'string', description: 'City code.' },
        city_name: { type: 'string', description: 'City name.' },
        destination_id: { type: 'string|null', description: 'Destination ID for this city. Pass to search --destination-id.' },
        province_code: { type: 'string|null', description: 'Province code.' },
        province_name: { type: 'string|null', description: 'Province name.' },
        country_code: { type: 'string|null', description: 'Country code.' },
        country_name: { type: 'string|null', description: 'Country name.' },
        lat: { type: 'float|null', description: 'Latitude (can be used with search --lat).' },
        lng: { type: 'float|null', description: 'Longitude (can be used with search --lng).' },
        time_zone: { type: 'string|null', description: 'Time zone identifier.' },
        popularity_score: { type: 'float|null', description: 'Popularity score for sorting/ranking.' },
      },
    },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug list-cities --country CN',
    output_summary: 'Returns cities[]. Use cities[].destination_id in search --destination-id, or cities[].lat/lng in search --lat/--lng.',
  },
  error_recovery: {
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after ~2s backoff.',
    PARAM_INVALID: 'Ensure --country is a non-empty ISO country code, then retry.',
  },
};

/** `hotel-redaug hotel-detail` schema. Read-only. */
export const hotelDetailSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: HOTEL_NOUN,
  verb: 'hotel-detail',
  description:
    "Get detailed information about a specific hotel including facilities, images, location, check-in/check-out times. Use to show the user hotel details before quoting/booking. hotel_id is stable but hotel_name/room_name may change upstream without notice. special_instructions (when requested via --settings hotelTextPolicies) MUST be shown to the user — the upstream data provider does not accept liability for booking issues caused by it not being displayed.",
  flags: {
    'hotel-id': { type: 'string', required: true, description: 'Hotel ID from search results (search.response.hotels[].hotel_id)' },
    'with-images': { type: 'bool', required: false, default: true, description: 'Include hotel images in the response (set false to reduce payload)' },
    settings: {
      type: 'string',
      required: false,
      description:
        'Optional on-demand upstream fields, comma-separated or JSON array — request only what you need: hotelFacilityNew, breakfast, importantNotices, parking, chargingParking, hotelCertificates, comment, hotelMeetingInfos, hotelVideoInfos, hotelTextPolicies (includes special_instructions), hotelStructuredPolicies.childPolicy, hotelStructuredPolicies.extraBedPolicy, hotelStructuredPolicies.petPolicy. Omitted codes are NOT returned by upstream (an upstream requirement, not a display choice). Pass hotelTextPolicies to get special_instructions.',
    },
  },
  response: {
    hotel_id: { type: 'string|int', description: 'Hotel identifier.' },
    hotel_name: { type: 'string|null', description: 'Hotel name.' },
    hotel_eng_name: { type: 'string|null', description: 'English hotel name.' },
    star: { type: 'int|null', description: 'Star rating.' },
    address: { type: 'string|null', description: 'Hotel address.' },
    intro: { type: 'string|null', description: 'Hotel introduction/description.' },
    appearance_image: { type: 'string|null', description: 'Main appearance image URL.' },
    telephone: { type: 'string|null', description: 'Hotel telephone number.' },
    country_name: { type: 'string|null', description: 'Country name.' },
    province_name: { type: 'string|null', description: 'Province name.' },
    city_name: { type: 'string|null', description: 'City name.' },
    district_name: { type: 'string|null', description: 'District name.' },
    business_name: { type: 'string|null', description: 'Business area name.' },
    lat: { type: 'float|null', description: 'Latitude.' },
    lng: { type: 'float|null', description: 'Longitude.' },
    check_in_time: { type: 'string|null', description: 'Hotel check-in time.' },
    check_out_time: { type: 'string|null', description: 'Hotel check-out time.' },
    room_num: { type: 'int|null', description: 'Number of rooms available.' },
    facilities: {
      type: 'array',
      description: 'Hotel facilities list.',
      items: {
        name: { type: 'string', description: 'Facility name.' },
        type: { type: 'string|null', description: 'Facility type/category.' },
      },
    },
    images: {
      type: 'array',
      description: 'Hotel-level images. Empty array when --with-images false.',
      items: {
        url: { type: 'string', description: 'Image URL.' },
        is_main: { type: 'bool', description: 'Whether this is the main image.' },
        type: { type: 'int|null', description: 'Image type/category.' },
      },
    },
    rooms: {
      type: 'array',
      description: "Room types with STATIC info only (area/floor/beds/max occupancy/images) — NOT live rates. room_id is the SAME id space as quote's roomItems[].roomId, so relate a room here to its live rate/price/product_token by matching room_id to quote's rates. ALWAYS use quote for price/availability/product_token; this verb never has them. Present this alongside quote's rate options so the user sees what the room actually looks like (area, beds, photos) before picking a rate, not just the one-line room_name from quote.",
      items: {
        room_id: { type: 'int|string|null', description: "Room type id. Matches quote's roomItems[].roomId — use to relate this room's detail to a specific quoted rate." },
        room_name: { type: 'string|null', description: 'Room type name.' },
        area_sqm: { type: 'string|null', description: 'Room area (upstream unit, commonly square meters), as a string.' },
        floor: { type: 'string|null', description: 'Floor(s) this room type is on (may be a range, e.g. "10-15").' },
        max_person: { type: 'int|null', description: 'Max total occupancy.' },
        max_adults: { type: 'int|null', description: 'Max adults.' },
        max_child: { type: 'int|null', description: 'Max children.' },
        allow_smoking: { type: 'bool|null', description: 'Whether smoking is allowed in this room type.' },
        beds: {
          type: 'array',
          description: 'Bed configuration for the room area.',
          items: {
            name: { type: 'string|null', description: 'Bed type name (e.g. "King Bed").' },
            width: { type: 'string|null', description: 'Bed width, upstream unit.' },
            num: { type: 'string|null', description: 'Number of this bed type.' },
          },
        },
        living_room_beds: {
          type: 'array',
          description: 'Bed configuration for a separate living-room area, when the room type has one. Same shape as beds.',
          items: {
            name: { type: 'string|null', description: 'Bed type name.' },
            width: { type: 'string|null', description: 'Bed width, upstream unit.' },
            num: { type: 'string|null', description: 'Number of this bed type.' },
          },
        },
        images: {
          type: 'array',
          description: 'Photos of this specific room type. Empty when --with-images false, or when upstream has none for this room.',
          items: {
            url: { type: 'string', description: 'Image URL.' },
            is_main: { type: 'bool', description: 'Whether this is the main image for the room.' },
            type: { type: 'int|null', description: 'Image type/category.' },
          },
        },
      },
    },
    comment: {
      type: 'array',
      description: "Guest review scores per channel. Empty unless --settings included 'comment'.",
      items: {
        channel: { type: 'string|null', description: 'Review source channel (e.g. EPS).' },
        average_score: { type: 'float|null', description: 'Average review score for that channel.' },
      },
    },
    hotel_certificates: {
      type: 'array',
      description: "Hotel business certificates/qualifications, when the property has any. Empty unless --settings included 'hotelCertificates' (and the property may simply have none).",
      items: {
        unify_code: { type: 'string|null', description: 'Unified business registration code.' },
        certification_name: { type: 'string|null', description: 'Certificate name.' },
        file_url: { type: 'string|null', description: 'Certificate image URL.' },
      },
    },
    hotel_text_policies: {
      type: 'array',
      description: "Free-text hotel policies keyed by code (hotelPolicy/instructions/specialInstructions/mandatoryFees/optionalFees/cleanAndSafety/importantNotices/ageLimit/checkInCheckOut). Empty unless --settings included 'hotelTextPolicies'. special_instructions below is also pulled from this same data, surfaced separately because it MUST be shown to the user.",
      items: {
        code: { type: 'string|null', description: 'Policy code, e.g. "specialInstructions".' },
        code_name: { type: 'string|null', description: 'Display name of the policy code (e.g. "特别入住说明").' },
        text: { type: 'string|null', description: 'Policy text (may contain HTML list markup from upstream).' },
      },
    },
    hotel_structured_policies: {
      type: 'object|null',
      description: "Structured child/extra-bed/pet policies (raw upstream shape, snake_cased). null unless --settings included the relevant hotelStructuredPolicies.* code(s).",
      properties: {
        child_policy: { type: 'object|null', description: 'Child stay/breakfast policy.' },
        extra_bed_policy: { type: 'object|null', description: 'Extra-bed charge policy by age range.' },
        pet_policy: { type: 'object|null', description: 'Pet/service-animal policy.' },
      },
    },
    special_instructions: {
      type: 'string|null',
      description: "IMPORTANT: the property's 'special check-in instructions' (upstream code specialInstructions, distinct from the general 'instructions' code). The Agent/caller MUST surface this to the user in the booking UI when present — the upstream data provider does not accept liability for booking problems caused by this not being displayed. Only populated when --settings included 'hotelTextPolicies'; null otherwise (does not mean the hotel has none — it means it wasn't requested).",
    },
  },
  example: {
    command: 'agenzo-merchant-cli hotel-redaug hotel-detail --hotel-id 10583772',
    output_summary: "Returns full hotel details including facilities, hotel images, AND rooms[] (per-room-type static info + photos). Use to present both the hotel and its room types before quoting — rooms[].room_id matches quote's roomItems[].roomId so the two can be shown together.",
  },
  error_recovery: {
    UPSTREAM_ERROR: 'Transient upstream error. Retry once after ~2s backoff.',
    PARAM_INVALID: 'Ensure --hotel-id is a non-empty string, then retry.',
    HOTEL_NOT_FOUND: 'The hotel is no longer available from the supplier (no matching hotel node in the upstream response). Do not retry with the same hotel_id — drop it from any local cache/mapping and re-search.',
  },
};

// ============================================================
// Unified cross-provider orders verb schemas ("orders" noun)
// ============================================================
//
// Unlike ride-elife / hotel-redaug, `orders` has NO business logic of its own
// — it is a thin read-only index spanning ALL providers (ride + hotel, and any
// future ones). Use it when the user asks for "my orders" / "order history"
// generically, without naming a specific business. Once you already know
// which business the user means (or need domain-specific columns like
// vehicle_class / hotel_name), prefer `ride-elife list-orders` /
// `hotel-redaug list-orders` instead.

export const ORDERS_NOUN = 'orders';

/** `orders list` schema — cross-provider order list (`GET /orders`). Read-only. */
export const unifiedOrdersListSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: ORDERS_NOUN,
  verb: 'list',
  description:
    'List orders across ALL providers (ride + hotel) in one call. Use this for generic "my orders" / "order history" requests. Prefer ride-elife/hotel-redaug list-orders when the user names a specific business.',
  flags: {
    'order-type': { type: 'string', required: false, description: 'Filter by provider: ride | hotel' },
    status: { type: 'string', required: false, description: 'Filter by NORMALIZED status (NOT the domain-specific status): PENDING | CONFIRMED | COMPLETED | CANCELLED | FAILED' },
    page: { type: 'int', required: false, default: 1, description: 'Page number', constraints: '>= 1' },
    'page-size': { type: 'int', required: false, default: 20, description: 'Items per page', constraints: '>= 1' },
  },
  response: {
    orders: {
      type: 'array',
      description: 'Slim cross-provider order-index items. For business-specific fields (vehicle_class, hotel_name, etc.), call `orders get --order-id <id>` or the domain-specific `get`.',
      items: {
        order_id: { type: 'string', description: 'Order id (rio_... for ride, hho_... for hotel). Pass to `orders get`.' },
        order_type: { type: 'string', description: "'ride' or 'hotel'" },
        status: { type: 'string', description: 'Normalized status: PENDING | CONFIRMED | COMPLETED | CANCELLED | FAILED' },
        amount: { type: 'float|null', description: 'Order amount in DECIMAL currency units (NOT cents)' },
        currency: { type: 'string|null', description: 'ISO 4217 currency code' },
        created_at: { type: 'string|null', description: 'ISO 8601 datetime' },
        updated_at: { type: 'string|null', description: 'ISO 8601 datetime' },
      },
    },
    total: { type: 'int', description: 'Total matching orders across all providers' },
    page: { type: 'int', description: 'Current page' },
    page_size: { type: 'int', description: 'Items per page' },
  },
  example: {
    command: 'agenzo-merchant-cli orders list --page 1 --page-size 10',
    output_summary:
      'Returns a paginated, cross-provider list of orders (both ride and hotel). If the user then asks about one order, use its order_id with `orders get`.',
  },
  error_recovery: {
    INVALID_REQUEST: 'The --status value is not one of PENDING/CONFIRMED/COMPLETED/CANCELLED/FAILED. Fix and retry.',
    INTERNAL_ERROR: 'Transient backend error. Retry once after a short delay.',
    PARAM_INVALID: 'Ensure --page / --page-size are positive integers, then retry.',
  },
};

/** `orders get` schema — cross-provider order detail (`GET /orders/{id}`). Read-only. */
export const unifiedOrdersGetSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: ORDERS_NOUN,
  verb: 'get',
  description:
    'Get a single order detail by id, regardless of which provider (ride/hotel) it belongs to. The platform resolves order_id -> provider internally and returns that provider\'s own detail shape.',
  flags: {
    'order-id': { type: 'string', required: true, description: 'Order id from `orders list` (rio_... for ride, hho_... for hotel)' },
  },
  response: {
    '(varies by order_type)': {
      type: 'object',
      description:
        'The response shape is delegated to the owning provider and therefore varies: a ride order returns the same shape as `ride-elife get`; a hotel order returns the same shape as `hotel-redaug get`. Treat the result as an opaque object and surface whatever fields it contains — do NOT assume a fixed schema.',
    },
  },
  example: {
    command: 'agenzo-merchant-cli orders get --order-id hho_01K...',
    output_summary: "Returns the order's detail, delegated to its owning provider (ride or hotel).",
  },
  error_recovery: {
    ORDER_NOT_FOUND: 'The order_id does not exist or does not belong to this developer/org. Verify the id from `orders list`. Do NOT retry blindly.',
    INTERNAL_ERROR: "The order's provider detail lookup is temporarily unavailable. Retry once after a short delay.",
  },
};

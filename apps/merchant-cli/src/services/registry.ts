/**
 * Built-in static capability registry (D4, merchant-domain only).
 *
 * NOTE: this is a CLI-bundled, single-merchant catalog — NOT a live backend
 * discovery feed. It does not reflect which services are enabled for the
 * current API key, nor the developer's billing mode (that is a per-developer
 * property decided by the backend, surfaced via the `book` response /
 * error codes, not advertised here). The §4.4.1 backend `/services` discovery
 * endpoint (BACK-063) + top-level `billing` block + `page` cursor are pending
 * impl; until they land, `services list/get` read this table.
 *
 * Each entry describes a CLI-exposed service: which `cli_noun` group hosts it,
 * the verbs it offers (with one-line descriptions), the recommended call
 * `workflow`, and discovery hints. `services list` renders a summary of these
 * entries and `services get <service-id>` returns one in full.
 *
 * `ServiceCapability` / the registry are merchant-domain specific (only
 * merchant-cli uses them) and stay in the app — they are NOT lifted to
 * `@agenzo/cli-core`.
 */

/** Discovery hints for a capability (§4.4.1 schema; `schema_url` reserved for backend feed). */
export interface ServiceDiscovery {
  /** Command an agent can run to discover the verbs in detail. */
  help_command: string;
  /** Reserved for the backend discovery feed's per-verb JSON schema URL (pending impl). */
  schema_url?: string;
}

export interface ServiceCapability {
  service_id: string;
  name: string;
  description: string;
  /** Service category (e.g. `ride`); part of the §4.4.1 schema form. */
  category: string;
  version: string;
  /** Upstream capability provider. */
  provider: string;
  /** Top-level CLI noun (command group) that hosts this service's verbs (`<category>-<provider>`). */
  cli_noun: string;
  /** Verb names exposed under `cli_noun`. */
  verbs: string[];
  /** One-line description per verb, keyed by verb name. */
  verb_descriptions: Record<string, string>;
  /** Ordered call sequence; `[cancel]` is optional. */
  workflow: string[];
  /** ISO date the capability became available. */
  since: string;
  discovery: ServiceDiscovery;
}

/** Static registry. This iteration ships ride-elife and hotel-redaug capabilities. */
export const SERVICE_REGISTRY: ServiceCapability[] = [
  {
    service_id: 'ride-elife',
    name: 'Ride hailing (eLife)',
    description: 'On-demand ride ordering: quote a fare, book it, poll status, and cancel.',
    category: 'ride',
    version: '1.0.0',
    provider: 'elife',
    cli_noun: 'ride-elife',
    verbs: ['quote', 'book', 'get', 'cancel', 'list-orders'],
    verb_descriptions: {
      quote: 'Request fare quotes for a ride between two points.',
      book: 'Book a ride using a quote_id returned by quote.',
      get: 'Retrieve a ride order by id (poll for status changes with --watch).',
      cancel: 'Cancel a ride order by id (may incur a fee).',
      'list-orders': 'List previously placed ride orders.',
    },
    workflow: ['quote', 'book', 'get (poll for status)', 'cancel (optional)'],
    since: '2026-06-01',
    discovery: { help_command: 'agenzo-merchant-cli ride-elife --help' },
  },
  {
    service_id: 'svc_01J0HT5REDAUG0001',
    name: 'Hotel booking (Redaug)',
    description:
      'International hotel booking via Redaug: search by location, real-time room/rate availability, two-step create-then-pay flow supporting monthly_settlement and pay_per_call (EVO) billing modes, cancel and partial check-out.',
    category: 'hotel',
    version: 'v1',
    provider: 'redaug',
    cli_noun: 'hotel-redaug',
    verbs: [
      'find-destination',
      'hotel-filters',
      'list-cities',
      'search',
      'hotel-detail',
      'quote',
      'create-order',
      'pay-order',
      'get',
      'cancel',
      'checkout',
      'get-checkout',
      'list-orders',
    ],
    verb_descriptions: {
      'find-destination': 'Resolve a free-text place into destinations.',
      'hotel-filters': 'Get available filter options for a location.',
      'list-cities': 'List the cities of a country.',
      search: 'Search hotels by destination or coordinates.',
      'hotel-detail': 'Get hotel detail (name/star/address/facilities/photos).',
      quote: 'Get real-time room types and bookable rates for a hotel.',
      'create-order': 'Create a hotel order without charging (locks the rate, no payment).',
      'pay-order': 'Settle a created order by --order-id (path chosen server-side by billing_mode: monthly_settlement or pay_per_call).',
      get: 'Query order status (poll for async confirmation).',
      cancel: 'Cancel an order (whole-order, in-policy).',
      checkout: 'Apply for partial check-out / out-of-policy cancellation.',
      'get-checkout': 'Poll a check-out application status.',
      'list-orders': 'List hotel orders (local store, no upstream call).',
    },
    workflow: [
      'find-destination / list-cities (optional)',
      'hotel-filters (optional)',
      'search',
      'hotel-detail (optional)',
      'quote',
      'create-order (locks the rate, no charge)',
      'pay-order (settles: monthly_settlement or pay_per_call)',
      'get (poll until CONFIRMED)',
      'cancel / checkout (optional)',
    ],
    since: '2026-06-25',
    discovery: { help_command: 'agenzo-merchant-cli hotel-redaug --help' },
  },
];

/** Look up a capability by its service_id. Returns undefined when not found. */
export function findService(serviceId: string): ServiceCapability | undefined {
  return SERVICE_REGISTRY.find((s) => s.service_id === serviceId);
}

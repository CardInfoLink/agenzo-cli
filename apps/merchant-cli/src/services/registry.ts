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

/** Static registry. This iteration ships a single `ride-elife` capability. */
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
];

/** Look up a capability by its service_id. Returns undefined when not found. */
export function findService(serviceId: string): ServiceCapability | undefined {
  return SERVICE_REGISTRY.find((s) => s.service_id === serviceId);
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { CliError, type ApiClient } from '@agenzo/cli-core';
import { registerServicesListCommand } from '../src/services/list.js';
import { registerServiceGetCommand } from '../src/services/get.js';
import { SERVICE_REGISTRY, findService } from '../src/services/registry.js';
import { buildProgram, captureStdout, captureStderr, parseJsonOutput } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// Local command-tree fixtures
//
// `services list/get` gate backend capabilities against the CLI's OWN command
// tree (the registered nouns + verbs), NOT a bundled schema. These helpers wire
// a realistic program: the ride-elife / hotel-redaug nouns with the same verbs
// the production index.ts registers (mirrors SERVICE_REGISTRY), so gating the
// local registry is an identity op — while letting individual tests drop a noun
// or verb to prove the gate hides what the CLI cannot run.
// ============================================================

const RIDE_VERBS = ['quote', 'book', 'get', 'cancel', 'list-orders'];
const HOTEL_VERBS = [
  'find-destination',
  'hotel-filters',
  'list-cities',
  'search',
  'hotel-detail',
  'quote',
  'book',
  'get',
  'cancel',
  'checkout',
  'get-checkout',
  'list-orders',
];

/** Register the service nouns/verbs on the program so the gate has a local map. */
function registerNouns(
  program: Command,
  opts: { ride?: string[] | null; hotel?: string[] | null } = {},
): void {
  if (opts.ride !== null) {
    const ride = program.command('ride-elife');
    for (const v of opts.ride ?? RIDE_VERBS) ride.command(v);
  }
  if (opts.hotel !== null) {
    const hotel = program.command('hotel-redaug');
    for (const v of opts.hotel ?? HOTEL_VERBS) hotel.command(v);
  }
}

/**
 * Mock discovery client. With no impl it REJECTS (simulates an unreachable
 * backend → the command falls back to the local registry). Pass an impl to
 * simulate a successful backend response.
 */
function mockDiscovery(impl?: (path: string) => Promise<unknown>): ApiClient {
  const get = impl
    ? vi.fn().mockImplementation(impl)
    : vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  return { get } as unknown as ApiClient;
}

function setupList(
  opts: {
    discovery?: ApiClient;
    nouns?: { ride?: string[] | null; hotel?: string[] | null };
  } = {},
) {
  const program = buildProgram();
  registerNouns(program, opts.nouns ?? {});
  const servicesCmd = program.command('services');
  const discoveryClient = opts.discovery ?? mockDiscovery();
  registerServicesListCommand(servicesCmd, { discoveryClient, program });
  return { program, discoveryClient };
}

function setupGet(
  opts: {
    discovery?: ApiClient;
    nouns?: { ride?: string[] | null; hotel?: string[] | null };
  } = {},
) {
  const program = buildProgram();
  registerNouns(program, opts.nouns ?? {});
  const servicesCmd = program.command('services');
  const discoveryClient = opts.discovery ?? mockDiscovery();
  registerServiceGetCommand(servicesCmd, { discoveryClient, program });
  return { program, discoveryClient };
}

// ============================================================
// services registry (unit) — §4.7 UT-REG-01..03 (Req 1.1, 1.2)
// ============================================================

// service_id is an opaque svc_-prefixed ULID (schema-standard.md §2.1), not the
// cli_noun; kept as a constant here so the test intent (rename-proof) is clear.
const RIDE_ELIFE_SERVICE_ID = 'svc_01KWTPBWDH5YZ52H717BFVWZA8';

describe('services registry (registry.ts)', () => {
  it('UT-REG-01: findService(RIDE_ELIFE_SERVICE_ID) returns the full capability', () => {
    const svc = findService(RIDE_ELIFE_SERVICE_ID);
    expect(svc).toBeDefined();
    expect(svc!.service_id).toBe(RIDE_ELIFE_SERVICE_ID);
    expect(svc!.category).toBe('ride');
    expect(svc!.provider).toBe('elife');
    expect(svc!.cli_noun).toBe('ride-elife');
    expect(svc!.verbs).toHaveLength(5);
    expect(svc!.workflow.length).toBeGreaterThan(0);
    expect(svc!.since).toBeTruthy();
    expect(svc!.discovery.help_command).toContain('ride-elife');
  });

  it('UT-REG-02: findService("nope") returns undefined', () => {
    expect(findService('nope')).toBeUndefined();
  });

  it('UT-REG-03: first registry entry exposes the 5 ride verbs in order', () => {
    expect(SERVICE_REGISTRY[0].verbs).toEqual(['quote', 'book', 'get', 'cancel', 'list-orders']);
  });
});

// ============================================================
// services list — §5.1 TC-SVC-LST-* (Req 1.1, 1.3, 5.1) + gating
// ============================================================

describe('services list', () => {
  it('TC-SVC-LST-01/02: backend unreachable → lists local registry, gated by the full command tree (identity)', async () => {
    const { program } = setupList(); // discovery rejects → fallback to registry

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json', '--api-key', 'k']);

    const payload = parseJsonOutput(out.text()) as { services: Array<Record<string, unknown>> };
    expect(Array.isArray(payload.services)).toBe(true);
    expect(payload.services.length).toBe(SERVICE_REGISTRY.length);

    const item = payload.services[0];
    // §4.4.1.1 list item shape — discovery-relevant subset.
    for (const key of [
      'service_id', 'name', 'category', 'provider', 'cli_noun', 'version', 'verbs', 'since', 'discovery',
    ]) {
      expect(item).toHaveProperty(key);
    }
    expect(item.service_id).toBe(RIDE_ELIFE_SERVICE_ID);
    expect(item.verbs).toEqual(['quote', 'book', 'get', 'cancel', 'list-orders']);
  });

  it('TC-SVC-LST-BACKEND: backend capabilities are returned and gated to locally-registered verbs', async () => {
    const discovery = mockDiscovery(async () => ({
      success: true,
      data: {
        capabilities: [
          {
            service_id: 'svc_01J0HT5REDAUG0001',
            name: 'Hotel booking (Redaug)',
            category: 'hotel',
            provider: 'redaug',
            cli_noun: 'hotel-redaug',
            version: 'v1',
            since: '2026-06-25',
            discovery: { help_command: 'agenzo-merchant-cli hotel-redaug --help' },
            // includes a verb this CLI build does NOT register:
            verbs: ['search', 'book', 'future-verb-not-in-cli'],
          },
          {
            // a whole service whose noun this CLI does not have at all:
            service_id: 'svc_unknown',
            name: 'Unknown',
            category: 'misc',
            provider: 'x',
            cli_noun: 'not-a-local-noun',
            version: 'v1',
            since: '',
            verbs: ['do'],
          },
        ],
      },
    }));
    const { program } = setupList({ discovery });

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json', '--api-key', 'k']);

    const payload = parseJsonOutput(out.text()) as { services: Array<Record<string, unknown>> };
    // The unknown noun is dropped entirely; only hotel-redaug survives.
    expect(payload.services.length).toBe(1);
    const hotel = payload.services[0];
    expect(hotel.cli_noun).toBe('hotel-redaug');
    // The verb the CLI doesn't register is filtered out.
    expect(hotel.verbs).toEqual(['search', 'book']);
  });

  it('TC-SVC-LST-GATE: a service whose noun is not registered locally is hidden (fallback)', async () => {
    const { program } = setupList({ nouns: { hotel: null } }); // only ride-elife registered

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json', '--api-key', 'k']);

    const payload = parseJsonOutput(out.text()) as { services: Array<Record<string, unknown>> };
    expect(payload.services.length).toBe(1);
    expect(payload.services[0].cli_noun).toBe('ride-elife');
  });

  it('TC-SVC-LST-06: list items omit the heavy verb_descriptions / workflow / description detail', async () => {
    const { program } = setupList();

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json', '--api-key', 'k']);

    const payload = parseJsonOutput(out.text()) as { services: Array<Record<string, unknown>> };
    const item = payload.services[0];
    expect(item).not.toHaveProperty('verb_descriptions');
    expect(item).not.toHaveProperty('workflow');
    expect(item).not.toHaveProperty('description');
  });

  it('TC-SVC-LST-04: json stdout is a single valid JSON with services + profile/endpoint envelope, stderr silent', async () => {
    const { program } = setupList();

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json', '--api-key', 'k']);

    // stdout parses as a single JSON object (pure payload).
    const payload = parseJsonOutput(out.text()) as Record<string, unknown>;
    expect(payload).toHaveProperty('services');
    // renderWithContext envelope (BACK-011): profile + endpoint (host only).
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');
    expect(typeof payload.profile).toBe('string');
    expect(typeof payload.endpoint).toBe('string');
    expect(String(payload.endpoint)).not.toContain('/api/');

    // json mode keeps stderr completely silent (no status icons / chrome).
    const stderrText = err.text();
    expect(stderrText).toBe('');
    expect(stderrText).not.toMatch(/[✓ℹ⚠✗]/);
  });

  it('TC-SVC-LST-05: table output renders headers and the ride-elife row', async () => {
    const { program } = setupList();

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'table', '--api-key', 'k']);

    const output = out.text();
    for (const header of ['Service ID', 'Name', 'Category', 'Provider', 'Version', 'Verbs']) {
      expect(output).toContain(header);
    }
    // Table row has no cli_noun column; assert on fields that are actually
    // rendered (service_id is opaque, not "ride-elife").
    expect(output).toContain(RIDE_ELIFE_SERVICE_ID);
    expect(output).toContain('Ride hailing (eLife)');
  });
});

// ============================================================
// services get — §5.2 TC-SVC-GET-* (Req 1.2, 1.3, 5.1) + gating
// ============================================================

describe('services get', () => {
  it('TC-SVC-GET-01/05: backend unreachable → service-layer view of the local capability + json envelope, stderr silent', async () => {
    const { program } = setupGet();

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'get', RIDE_ELIFE_SERVICE_ID, '--format', 'json', '--api-key', 'k']);

    const payload = parseJsonOutput(out.text()) as Record<string, unknown>;
    expect(payload.service_id).toBe(RIDE_ELIFE_SERVICE_ID);
    // Service-layer shape (schema-standard.md §3): identity + workflow +
    // verbs_summary + schema_ref. No schema_content has no selection_hints/
    // conventions/cross_service_recovery to surface — that's fine, they're
    // simply absent (degrades gracefully), never faked.
    expect(payload).toHaveProperty('workflow');
    expect(payload).toHaveProperty('verbs_summary');
    expect(payload).toHaveProperty('schema_ref');
    expect(payload).not.toHaveProperty('selection_hints');
    // profile/endpoint envelope.
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');

    expect(err.text()).toBe('');
  });

  it('TC-SVC-GET-SERVICE-LAYER: backend-sourced capability projects onto the service-layer shape, omitting per-verb flags/response', async () => {
    const discovery = mockDiscovery(async () => ({
      success: true,
      data: {
        service_id: 'svc_01J0HT5REDAUG0001',
        name: 'Hotel booking (Redaug)',
        category: 'hotel',
        provider: 'redaug',
        version: 'v1',
        cli_noun: 'hotel-redaug',
        verbs: ['search', 'book', 'future-verb'],
        verb_descriptions: { search: 'Search hotels.', book: 'Book a hotel.' },
        discovery: { help_command: 'agenzo-merchant-cli hotel-redaug --help' },
        schema_content: {
          selection_hints: { use_when: ['hotel stays'], not_for: ['rides'] },
          schema_ref: {
            schema_url: 'https://agent.everonet.com/schemas/hotel-redaug.json',
            help_command: 'agenzo-merchant-cli hotel-redaug <verb> --help --format json',
          },
          conventions: { amount_unit: 'DECIMAL currency units.' },
          workflow: {
            description: 'search → quote → create-order → pay-order',
            steps: [{ verb: 'search', next: 'book', data_flow: '...', selection_hint: null }],
          },
          cross_service_recovery: { no_availability: 'try another hotel service' },
          verbs: {
            search: {
              description: 'search hotels',
              annotations: { write: false },
              flags: { keyword: { type: 'string' } },
              response: { hotels: { type: 'array' } },
              example: { command: '...', output_summary: '...' },
              error_recovery: { NO_AVAILABILITY: 'retry' },
            },
            book: { description: 'book a hotel', annotations: { write: true } },
            'future-verb': { description: 'not in this CLI' },
          },
        },
      },
    }));
    const { program } = setupGet({ discovery });

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'services', 'get', 'svc_01J0HT5REDAUG0001', '--format', 'json', '--api-key', 'k',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, unknown>;

    // Service-layer fields are present and correctly sourced from schema_content.
    expect(payload.selection_hints).toEqual({ use_when: ['hotel stays'], not_for: ['rides'] });
    expect(payload.schema_ref).toEqual({
      schema_url: 'https://agent.everonet.com/schemas/hotel-redaug.json',
      help_command: 'agenzo-merchant-cli hotel-redaug <verb> --help --format json',
    });
    expect(payload.conventions).toEqual({ amount_unit: 'DECIMAL currency units.' });
    expect(payload.cross_service_recovery).toEqual({ no_availability: 'try another hotel service' });
    // Full workflow object (not the flattened array), unchanged from the schema.
    expect(payload.workflow).toMatchObject({
      description: 'search → quote → create-order → pay-order',
      steps: [{ verb: 'search', next: 'book', data_flow: '...', selection_hint: null }],
    });

    // verbs_summary: verb + description + annotations only — gated to local
    // verbs (future-verb dropped), no flags/response/example/error_recovery.
    expect(payload.verbs_summary).toEqual([
      { verb: 'search', description: 'Search hotels.', annotations: { write: false } },
      { verb: 'book', description: 'Book a hotel.', annotations: { write: true } },
    ]);

    // The raw schema_content / per-verb capability detail must never leak
    // into the service-layer response — that's the capability layer's job.
    expect(payload).not.toHaveProperty('schema_content');
    const summaryText = JSON.stringify(payload.verbs_summary);
    expect(summaryText).not.toContain('flags');
    expect(summaryText).not.toContain('response');
    expect(summaryText).not.toContain('error_recovery');
  });

  it('TC-SVC-GET-GATE: backend service whose noun is not local → SERVICE_NOT_FOUND', async () => {
    const discovery = mockDiscovery(async () => ({
      success: true,
      data: {
        service_id: 'svc_unknown',
        name: 'Unknown',
        cli_noun: 'not-a-local-noun',
        verbs: ['do'],
      },
    }));
    const { program } = setupGet({ discovery });

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'services', 'get', 'svc_unknown', '--format', 'json', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('TC-SVC-GET-04: table output renders the key/value block plus the service-layer sections', async () => {
    const { program } = setupGet();

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'get', RIDE_ELIFE_SERVICE_ID, '--format', 'table', '--api-key', 'k']);

    const output = out.text();
    expect(output).toContain('ride-elife');
    expect(output).toContain('workflow:');
    expect(output).toContain('verbs_summary:');
  });

  it('TC-SVC-GET-02: miss throws CliError(SERVICE_NOT_FOUND) and points to "services list"', async () => {
    const { program } = setupGet();

    const out = captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'services', 'get', 'nope', '--format', 'json', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });

    // Re-run on a fresh program to assert message + error type.
    const { program: program2 } = setupGet();
    let caught: unknown;
    try {
      await program2.parseAsync(['node', 'cli', 'services', 'get', 'nope', '--format', 'json', '--api-key', 'k']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain('services list');

    // Failure path must not emit any business payload on stdout.
    expect(out.text()).toBe('');
  });
});

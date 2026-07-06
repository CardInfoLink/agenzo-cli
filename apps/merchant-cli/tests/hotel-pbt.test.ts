/**
 * Property-based tests (fast-check) for hotel-redaug input validation and
 * structured-flag parsing.
 *
 * Feature: merchant-cli-hotel-redaug
 *
 * Covers:
 *   Property 1: Coordinate range validation (Requirements 2.3, 2.4)
 *   Property 2: Stay-date format and strict ordering (Requirements 2.5, 3.4)
 *   Property 3: Structured JSON flags parsed and validated (Requirements 4.5, 7.4)
 *   Property 5: Required-flag validation halts before any request (Requirements 2.3, 3.3, 4.3, 5.2, 6.3, 7.3, 8.2)
 *   Property 11: list-orders query assembly (Requirements 9.3, 9.4)
 *
 * **Validates: Requirements 17.2**
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { CliError } from '@agenzo/cli-core';
import type { ApiClient } from '@agenzo/cli-core';

// Direct pure-function imports for Property 3
import { parsePriceItems } from '../src/hotel-redaug/create-order.js';
import { parseCheckoutRooms } from '../src/hotel-redaug/checkout.js';

// Command registrars for Properties 1, 2, 5, 11
import { registerHotelSearchCommand } from '../src/hotel-redaug/search.js';
import { registerHotelQuoteCommand } from '../src/hotel-redaug/quote.js';
import { registerHotelCreateOrderCommand } from '../src/hotel-redaug/create-order.js';
import { registerHotelGetCommand } from '../src/hotel-redaug/get.js';
import { registerHotelCancelCommand } from '../src/hotel-redaug/cancel.js';
import { registerHotelCheckoutCommand } from '../src/hotel-redaug/checkout.js';
import { registerHotelGetCheckoutCommand } from '../src/hotel-redaug/get-checkout.js';
import { registerHotelListOrdersCommand } from '../src/hotel-redaug/list-orders.js';
import { registerHotelFindDestinationCommand } from '../src/hotel-redaug/find-destination.js';
import { registerHotelFiltersCommand } from '../src/hotel-redaug/hotel-filters.js';
import { registerHotelListCitiesCommand } from '../src/hotel-redaug/list-cities.js';
import { registerHotelDetailCommand } from '../src/hotel-redaug/hotel-detail.js';

import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// Mock @inquirer/prompts so PromptEngine.resolveInput and confirm work
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// Helpers
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function hotelProgram(apiClient: Mock) {
  const program = buildProgram();
  const hotel = program.command('hotel-redaug');
  const deps = { apiClient: apiClient as unknown as ApiClient };
  registerHotelSearchCommand(hotel, deps);
  registerHotelQuoteCommand(hotel, deps);
  registerHotelCreateOrderCommand(hotel, deps);
  registerHotelGetCommand(hotel, deps);
  registerHotelCancelCommand(hotel, deps);
  registerHotelCheckoutCommand(hotel, deps);
  registerHotelGetCheckoutCommand(hotel, deps);
  registerHotelListOrdersCommand(hotel, deps);
  registerHotelFindDestinationCommand(hotel, deps);
  registerHotelFiltersCommand(hotel, deps);
  registerHotelListCitiesCommand(hotel, deps);
  registerHotelDetailCommand(hotel, deps);
  return program;
}

const BASE = ['node', 'cli', 'hotel-redaug'];

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 1: Coordinate range validation
// Validates: Requirements 2.3, 2.4
// ============================================================

describe('PBT — Property 1: Coordinate range validation', () => {
  it('valid coords in [-90,90]x[-180,180] do NOT throw coord PARAM_INVALID', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
        async (lat, lng) => {
          const api = mockApiClient({ '/hotel/search': { hotels: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          let caught: unknown;
          try {
            await program.parseAsync([
              ...BASE, 'search',
              '--api-key', 'k',
              '--lat', String(lat),
              '--lng', String(lng),
              '--check-in', '2026-06-01',
              '--check-out', '2026-06-03',
              '--format', 'json',
            ]);
          } catch (e) {
            caught = e;
          }

          // If it threw PARAM_INVALID, it must NOT be about coords
          if (caught instanceof CliError && (caught as CliError).code === 'PARAM_INVALID') {
            const msg = (caught as CliError).message.toLowerCase();
            if (msg.includes('lat') || msg.includes('lng') || msg.includes('between')) {
              return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('out-of-range or non-finite coords throw PARAM_INVALID and 0 requests', async () => {
    const outOfRangeLat = fc.oneof(
      fc.double({ min: 90.0001, max: 1000, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -1000, max: -90.0001, noNaN: true, noDefaultInfinity: true }),
      fc.constant(Infinity),
      fc.constant(-Infinity),
      fc.constant(NaN),
    );
    const outOfRangeLng = fc.oneof(
      fc.double({ min: 180.0001, max: 1000, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -1000, max: -180.0001, noNaN: true, noDefaultInfinity: true }),
      fc.constant(Infinity),
      fc.constant(-Infinity),
      fc.constant(NaN),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // bad lat, valid lng
          fc.tuple(outOfRangeLat, fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true })),
          // valid lat, bad lng
          fc.tuple(fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }), outOfRangeLng),
          // both bad
          fc.tuple(outOfRangeLat, outOfRangeLng),
        ),
        async ([lat, lng]) => {
          const api = mockApiClient();
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          let caught: unknown;
          try {
            await program.parseAsync([
              ...BASE, 'search',
              '--api-key', 'k',
              '--lat', String(lat),
              '--lng', String(lng),
              '--check-in', '2026-06-01',
              '--check-out', '2026-06-03',
              '--format', 'json',
            ]);
          } catch (e) {
            caught = e;
          }

          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
          expect(api.post).not.toHaveBeenCalled();
          expect(api.get).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 2: Stay-date format and strict ordering
// Validates: Requirements 2.5, 3.4
// ============================================================

describe('PBT — Property 2: Stay-date format and strict ordering', () => {
  const validDatePair = fc.tuple(
    fc.integer({ min: 2024, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  ).chain(([y, m, d]) => {
    const checkIn = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return fc.integer({ min: 1, max: 14 }).map((offset) => {
      const dt = new Date(Date.UTC(y, m - 1, d + offset));
      const checkOut = `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
      return [checkIn, checkOut] as [string, string];
    });
  });

  it('valid YYYY-MM-DD pairs with check-out > check-in do NOT throw date errors', async () => {
    await fc.assert(
      fc.asyncProperty(validDatePair, async ([checkIn, checkOut]) => {
        const api = mockApiClient({ '/hotel/search': { hotels: [] } });
        const program = hotelProgram(api);
        captureStdout();
        captureStderr();

        let caught: unknown;
        try {
          await program.parseAsync([
            ...BASE, 'search',
            '--api-key', 'k',
            '--lat', '30', '--lng', '120',
            '--check-in', checkIn,
            '--check-out', checkOut,
            '--format', 'json',
          ]);
        } catch (e) {
          caught = e;
        }

        // Should NOT throw PARAM_INVALID about dates
        if (caught instanceof CliError && (caught as CliError).code === 'PARAM_INVALID') {
          const msg = (caught as CliError).message.toLowerCase();
          if (msg.includes('date') || msg.includes('check-in') || msg.includes('check-out')) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('invalid date strings throw PARAM_INVALID with 0 requests', async () => {
    const invalidDate = fc.oneof(
      fc.constant('not-a-date'),
      fc.constant('2026-13-01'),
      fc.constant('2026-02-30'),
      fc.constant('abcd-ef-gh'),
      fc.constant('2026/06/01'),
      fc.constant('20260601'),
      fc.constant(''),
      fc.string({ minLength: 1, maxLength: 10 }).filter(
        (s) => !/^\d{4}-\d{2}-\d{2}$/.test(s),
      ),
    );

    await fc.assert(
      fc.asyncProperty(invalidDate, async (badDate) => {
        const api = mockApiClient();
        const program = hotelProgram(api);
        captureStdout();
        captureStderr();

        let caught: unknown;
        try {
          await program.parseAsync([
            ...BASE, 'search',
            '--api-key', 'k',
            '--lat', '30', '--lng', '120',
            '--check-in', badDate,
            '--check-out', '2026-06-10',
            '--format', 'json',
          ]);
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(CliError);
        expect((caught as CliError).code).toBe('PARAM_INVALID');
        expect(api.post).not.toHaveBeenCalled();
        expect(api.get).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('check-out <= check-in throws PARAM_INVALID with 0 requests', async () => {
    const sameDatePair = fc.tuple(
      fc.integer({ min: 2024, max: 2030 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
    ).map(([y, m, d]) => {
      const date = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return [date, date] as [string, string];
    });

    await fc.assert(
      fc.asyncProperty(sameDatePair, async ([checkIn, checkOut]) => {
        const api = mockApiClient();
        const program = hotelProgram(api);
        captureStdout();
        captureStderr();

        let caught: unknown;
        try {
          await program.parseAsync([
            ...BASE, 'search',
            '--api-key', 'k',
            '--lat', '30', '--lng', '120',
            '--check-in', checkIn,
            '--check-out', checkOut,
            '--format', 'json',
          ]);
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(CliError);
        expect((caught as CliError).code).toBe('PARAM_INVALID');
        expect(api.post).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 3: Structured JSON flags parsed and validated
// Validates: Requirements 4.5, 7.4
// ============================================================

describe('PBT — Property 3: Structured JSON flags are parsed and validated', () => {
  describe('parsePriceItems', () => {
    it('valid JSON arrays with correct fields return the array', () => {
      const validItem = fc.record({
        sale_date: fc.date({ noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)),
        sale_price: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
        breakfast_num: fc.integer({ min: 0, max: 10 }),
      });

      fc.assert(
        fc.property(fc.array(validItem, { minLength: 1, maxLength: 5 }), (items) => {
          const raw = JSON.stringify(items);
          const result = parsePriceItems(raw);
          expect(result).toEqual(items);
        }),
        { numRuns: 100 },
      );
    });

    it('non-JSON strings throw PARAM_INVALID', () => {
      const nonJson = fc.string().filter((s) => {
        try { JSON.parse(s); return false; } catch { return true; }
      });

      fc.assert(
        fc.property(nonJson, (raw) => {
          let caught: unknown;
          try { parsePriceItems(raw); } catch (e) { caught = e; }
          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
        }),
        { numRuns: 100 },
      );
    });

    it('non-array JSON throws PARAM_INVALID', () => {
      const nonArray = fc.oneof(
        fc.integer().map((n) => JSON.stringify(n)),
        fc.string().map((s) => JSON.stringify(s)),
        fc.constant('null'),
        fc.constant('true'),
        fc.record({ a: fc.integer() }).map((o) => JSON.stringify(o)),
      );

      fc.assert(
        fc.property(nonArray, (raw) => {
          let caught: unknown;
          try { parsePriceItems(raw); } catch (e) { caught = e; }
          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
        }),
        { numRuns: 100 },
      );
    });

    it('arrays with missing fields throw PARAM_INVALID', () => {
      const badItem = fc.oneof(
        fc.record({ sale_date: fc.string() }),
        fc.record({ sale_price: fc.integer(), breakfast_num: fc.integer() }),
        fc.record({ sale_date: fc.integer(), sale_price: fc.double({ noNaN: true }), breakfast_num: fc.integer() }),
      );

      fc.assert(
        fc.property(fc.array(badItem, { minLength: 1, maxLength: 3 }), (items) => {
          const raw = JSON.stringify(items);
          let caught: unknown;
          try { parsePriceItems(raw); } catch (e) { caught = e; }
          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('parseCheckoutRooms', () => {
    it('valid JSON arrays with correct fields return the array', () => {
      const validRoom = fc.record({
        room_index: fc.string({ minLength: 1, maxLength: 5 }),
        guest_name: fc.string({ minLength: 1, maxLength: 30 }),
        cancel_check_in_date: fc.date({ noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)),
      });

      fc.assert(
        fc.property(fc.array(validRoom, { minLength: 1, maxLength: 4 }), (rooms) => {
          const raw = JSON.stringify(rooms);
          const result = parseCheckoutRooms(raw);
          expect(result).toEqual(rooms);
        }),
        { numRuns: 100 },
      );
    });

    it('non-JSON strings throw PARAM_INVALID', () => {
      const nonJson = fc.string().filter((s) => {
        try { JSON.parse(s); return false; } catch { return true; }
      });

      fc.assert(
        fc.property(nonJson, (raw) => {
          let caught: unknown;
          try { parseCheckoutRooms(raw); } catch (e) { caught = e; }
          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
        }),
        { numRuns: 100 },
      );
    });

    it('non-array JSON throws PARAM_INVALID', () => {
      const nonArray = fc.oneof(
        fc.integer().map((n) => JSON.stringify(n)),
        fc.string().map((s) => JSON.stringify(s)),
        fc.constant('null'),
        fc.constant('{}'),
      );

      fc.assert(
        fc.property(nonArray, (raw) => {
          let caught: unknown;
          try { parseCheckoutRooms(raw); } catch (e) { caught = e; }
          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
        }),
        { numRuns: 100 },
      );
    });

    it('arrays with missing or wrong-typed fields throw PARAM_INVALID', () => {
      const badRoom = fc.oneof(
        fc.record({ room_index: fc.string() }),
        fc.record({ room_index: fc.integer(), guest_name: fc.string(), cancel_check_in_date: fc.string() }),
        fc.record({ room_index: fc.string(), guest_name: fc.integer(), cancel_check_in_date: fc.string() }),
      );

      fc.assert(
        fc.property(fc.array(badRoom, { minLength: 1, maxLength: 3 }), (rooms) => {
          const raw = JSON.stringify(rooms);
          let caught: unknown;
          try { parseCheckoutRooms(raw); } catch (e) { caught = e; }
          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
        }),
        { numRuns: 100 },
      );
    });
  });
});

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 5: Required-flag validation halts before any request
// Validates: Requirements 2.3, 3.3, 4.3, 5.2, 6.3, 7.3, 8.2
// ============================================================

describe('PBT — Property 5: Required-flag validation halts before any request', () => {
  const verbConfigs: Array<{
    verb: string;
    requiredFlags: string[];
    baseArgs: string[];
  }> = [
    {
      verb: 'search',
      requiredFlags: ['--lat', '--lng', '--check-in', '--check-out'],
      baseArgs: ['--lat', '30', '--lng', '120', '--check-in', '2026-06-01', '--check-out', '2026-06-03'],
    },
    {
      verb: 'quote',
      requiredFlags: ['--hotel-id', '--check-in', '--check-out'],
      baseArgs: ['--hotel-id', 'h1', '--check-in', '2026-06-01', '--check-out', '2026-06-03'],
    },
    {
      verb: 'create-order',
      requiredFlags: ['--product-token', '--total-amount', '--currency', '--price-items', '--check-in', '--check-out', '--guest-name', '--contact-name', '--contact-phone'],
      baseArgs: [
        '--product-token', 'tok1', '--total-amount', '100', '--currency', 'USD',
        '--price-items', '[{"sale_date":"2026-06-01","sale_price":100,"breakfast_num":0}]',
        '--check-in', '2026-06-01', '--check-out', '2026-06-02',
        '--guest-name', 'John', '--contact-name', 'John', '--contact-phone', '1234567890',
        '--idempotency-key', 'key1', '--yes',
      ],
    },
    {
      verb: 'get',
      requiredFlags: ['--order-id'],
      baseArgs: ['--order-id', 'ord1'],
    },
    {
      verb: 'cancel',
      requiredFlags: ['--order-id', '--fc-order-code'],
      baseArgs: ['--order-id', 'ord1', '--fc-order-code', 'fc1', '--idempotency-key', 'key1', '--yes'],
    },
    {
      verb: 'checkout',
      requiredFlags: ['--order-id', '--fc-order-code', '--reason', '--checkout-rooms'],
      baseArgs: [
        '--order-id', 'ord1', '--fc-order-code', 'fc1', '--reason', 'test',
        '--checkout-rooms', '[{"room_index":"1","guest_name":"John","cancel_check_in_date":"2026-06-01"}]',
        '--idempotency-key', 'key1', '--yes',
      ],
    },
    {
      verb: 'get-checkout',
      requiredFlags: ['--task-order-code'],
      baseArgs: ['--task-order-code', 'task1'],
    },
    {
      verb: 'find-destination',
      requiredFlags: ['--keyword'],
      baseArgs: ['--keyword', 'tokyo'],
    },
    {
      verb: 'hotel-filters',
      requiredFlags: ['--lat', '--lng'],
      baseArgs: ['--lat', '30', '--lng', '120'],
    },
    {
      verb: 'list-cities',
      requiredFlags: ['--country'],
      baseArgs: ['--country', 'CN'],
    },
    {
      verb: 'hotel-detail',
      requiredFlags: ['--hotel-id'],
      baseArgs: ['--hotel-id', 'h1'],
    },
  ];

  for (const { verb, requiredFlags, baseArgs } of verbConfigs) {
    if (requiredFlags.length === 0) continue;

    it(`${verb}: omitting a required flag → PARAM_INVALID and 0 requests`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...requiredFlags),
          async (flagToOmit) => {
            const api = mockApiClient();
            const program = hotelProgram(api);
            captureStdout();
            captureStderr();

            // Build args with the target flag and its value removed
            const filteredArgs: string[] = [];
            let skip = false;
            for (let i = 0; i < baseArgs.length; i++) {
              if (baseArgs[i] === flagToOmit) {
                skip = true;
                continue;
              }
              if (skip) {
                skip = false;
                continue;
              }
              filteredArgs.push(baseArgs[i]);
            }

            const args = [
              ...BASE, verb,
              '--api-key', 'k',
              '--format', 'json',
              ...filteredArgs,
            ];

            let caught: unknown;
            try {
              await program.parseAsync(args);
            } catch (e) {
              caught = e;
            }

            expect(caught).toBeInstanceOf(CliError);
            expect((caught as CliError).code).toBe('PARAM_INVALID');
            expect(api.post).not.toHaveBeenCalled();
            expect(api.get).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 100 },
      );
    });
  }
});

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 11: list-orders query assembly
// Validates: Requirements 9.3, 9.4
// ============================================================

describe('PBT — Property 11: list-orders query assembly', () => {
  it('valid positive-int page/page-size do NOT throw PARAM_INVALID', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        async (page, pageSize) => {
          const api = mockApiClient({
            '/hotel/orders': { orders: [], total: 0, page, page_size: pageSize },
          });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          let caught: unknown;
          try {
            await program.parseAsync([
              ...BASE, 'list-orders',
              '--api-key', 'k',
              '--page', String(page),
              '--page-size', String(pageSize),
              '--format', 'json',
            ]);
          } catch (e) {
            caught = e;
          }

          // Should succeed (no PARAM_INVALID)
          if (caught instanceof CliError) {
            expect((caught as CliError).code).not.toBe('PARAM_INVALID');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('0, negative, or non-integer page/page-size throws PARAM_INVALID before request', async () => {
    const badPagination = fc.oneof(
      fc.constant('0'),
      fc.integer({ min: -1000, max: -1 }).map(String),
      fc.double({ min: 0.1, max: 100, noNaN: true, noDefaultInfinity: true })
        .filter((n) => !Number.isInteger(n))
        .map(String),
      fc.constant('-5'),
    );

    await fc.assert(
      fc.asyncProperty(
        badPagination,
        fc.constantFrom('page', 'page-size'),
        async (badValue, whichFlag) => {
          const api = mockApiClient();
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          const args = [
            ...BASE, 'list-orders',
            '--api-key', 'k',
            '--format', 'json',
          ];

          if (whichFlag === 'page') {
            args.push('--page', badValue, '--page-size', '20');
          } else {
            args.push('--page', '1', '--page-size', badValue);
          }

          let caught: unknown;
          try {
            await program.parseAsync(args);
          } catch (e) {
            caught = e;
          }

          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_INVALID');
          expect(api.post).not.toHaveBeenCalled();
          expect(api.get).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 4: Request assembly correct across verbs
// Validates: Requirements 1.4, 1.5, 2.2, 3.2, 4.2, 6.2, 7.2, 9.2, 10.1, 13.1
// ============================================================

describe('PBT — Property 4: Request assembly is correct and uniform across verbs', () => {
  /**
   * For a representative subset of verbs (search with coord branch, quote,
   * book, list-orders, find-destination), valid flag sets produce EXACTLY one
   * API call whose path, method (post/get), auth ({type:'api-key', key}), body
   * keys (snake_case), and — for writes — an Idempotency-Key header that is NOT
   * in the body.
   */

  it('search (coord branch) → POST /hotel/search with correct auth and snake_case body', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Avoid -0 which is a JS edge case: Number('-0') === 0 but Object.is(-0, 0) is false
        fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }).filter((n) => n !== 0 || Object.is(n, 0)),
        fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }).filter((n) => n !== 0 || Object.is(n, 0)),
        fc.integer({ min: 1, max: 50 }),
        async (lat, lng, distance) => {
          const api = mockApiClient({ '/hotel/search': { hotels: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          await program.parseAsync([
            ...BASE, 'search',
            '--api-key', 'test-key-123',
            '--lat', String(lat),
            '--lng', String(lng),
            '--distance', String(distance),
            '--check-in', '2026-06-01',
            '--check-out', '2026-06-03',
            '--format', 'json',
          ]);

          // Exactly one POST call
          expect(api.post).toHaveBeenCalledTimes(1);
          expect(api.get).not.toHaveBeenCalled();

          const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, unknown>];
          expect(path).toBe('/hotel/search');
          expect(auth).toEqual({ type: 'api-key', key: 'test-key-123' });

          // Body keys are snake_case — compare with Number() since String(-0)→"0"→Number→0
          expect(body.lat).toBe(Number(String(lat)));
          expect(body.lng).toBe(Number(String(lng)));
          expect(body.distance).toBe(distance);
          expect(body.check_in).toBe('2026-06-01');
          expect(body.check_out).toBe('2026-06-03');
          // No camelCase keys
          expect(body).not.toHaveProperty('checkIn');
          expect(body).not.toHaveProperty('checkOut');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('quote → POST /hotel/quote with correct auth and snake_case body', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 5 }),
        async (hotelId, roomNum) => {
          const api = mockApiClient({ '/hotel/quote': { rates: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          await program.parseAsync([
            ...BASE, 'quote',
            '--api-key', 'qkey',
            '--hotel-id', hotelId,
            '--check-in', '2026-07-01',
            '--check-out', '2026-07-03',
            '--room-num', String(roomNum),
            '--format', 'json',
          ]);

          expect(api.post).toHaveBeenCalledTimes(1);
          expect(api.get).not.toHaveBeenCalled();

          const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, unknown>];
          expect(path).toBe('/hotel/quote');
          expect(auth).toEqual({ type: 'api-key', key: 'qkey' });
          expect(body.hotel_id).toBe(hotelId);
          expect(body.check_in).toBe('2026-07-01');
          expect(body.check_out).toBe('2026-07-03');
          expect(body.room_num).toBe(roomNum);
          // No camelCase
          expect(body).not.toHaveProperty('hotelId');
          expect(body).not.toHaveProperty('roomNum');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('create-order → POST /hotel/create-order with Idempotency-Key header NOT in body', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Exclude keys starting with '-' which commander would interpret as an
        // option flag when passed via argv.
        fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/).filter((s) => !s.startsWith('-')),
        async (idempKey) => {
          const api = mockApiClient({ '/hotel/create-order': { order_id: 'o1', fc_order_code: 'fc1', order_status: 'AWAITING_PAYMENT', total_amount: 500, currency: 'CNY', rooms: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          await program.parseAsync([
            ...BASE, 'create-order',
            '--api-key', 'bkey',
            '--product-token', 'tok1',
            '--total-amount', '500',
            '--currency', 'CNY',
            '--price-items', '[{"sale_date":"2026-07-01","sale_price":500,"breakfast_num":0}]',
            '--check-in', '2026-07-01',
            '--check-out', '2026-07-02',
            '--guest-name', 'Alice',
            '--contact-name', 'Alice',
            '--contact-phone', '1234567890',
            '--idempotency-key', idempKey,
            '--yes',
            '--format', 'json',
          ]);

          expect(api.post).toHaveBeenCalledTimes(1);
          expect(api.get).not.toHaveBeenCalled();

          const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, unknown>, Record<string, string>];
          expect(path).toBe('/hotel/create-order');
          expect(auth).toEqual({ type: 'api-key', key: 'bkey' });

          // Idempotency-Key in header, NOT in body
          expect(headers).toHaveProperty('Idempotency-Key', idempKey);
          expect(body).not.toHaveProperty('Idempotency-Key');
          expect(body).not.toHaveProperty('idempotency_key');
          expect(body).not.toHaveProperty('idempotencyKey');

          // Body has snake_case keys
          expect(body.product_token).toBe('tok1');
          expect(body.total_amount).toBe(500);
          expect(body.currency).toBe('CNY');
          expect(body.check_in).toBe('2026-07-01');
          expect(body.check_out).toBe('2026-07-02');
          expect(body.guest_name).toBe('Alice');
          expect(body.contact_name).toBe('Alice');
          expect(body.contact_phone).toBe('1234567890');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('list-orders → GET /hotel/orders with correct auth and query params', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 100 }),
        async (page, pageSize) => {
          const api = mockApiClient({ '/hotel/orders': { orders: [], total: 0, page, page_size: pageSize } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          await program.parseAsync([
            ...BASE, 'list-orders',
            '--api-key', 'lkey',
            '--page', String(page),
            '--page-size', String(pageSize),
            '--format', 'json',
          ]);

          expect(api.get).toHaveBeenCalledTimes(1);
          expect(api.post).not.toHaveBeenCalled();

          const [path, auth, params] = api.get.mock.calls[0] as [string, unknown, Record<string, string>];
          expect(path).toBe('/hotel/orders');
          expect(auth).toEqual({ type: 'api-key', key: 'lkey' });
          expect(params.page).toBe(String(page));
          expect(params.page_size).toBe(String(pageSize));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('find-destination → POST /hotel/find-destination with correct auth and body', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        async (keyword) => {
          const api = mockApiClient({ '/hotel/find-destination': { destinations: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          await program.parseAsync([
            ...BASE, 'find-destination',
            '--api-key', 'fkey',
            '--keyword', keyword,
            '--format', 'json',
          ]);

          expect(api.post).toHaveBeenCalledTimes(1);
          expect(api.get).not.toHaveBeenCalled();

          const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, unknown>];
          expect(path).toBe('/hotel/find-destination');
          expect(auth).toEqual({ type: 'api-key', key: 'fkey' });
          expect(body.keyword).toBe(keyword);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 6: Amounts forwarded as decimal units
// Validates: Requirements 3.5, 4.4, 11.5
// ============================================================

describe('PBT — Property 6: Amounts are forwarded and rendered as decimal units', () => {
  /**
   * For any valid --total-amount (arbitrary finite positive double) passed to
   * book, the body's total_amount equals the input EXACTLY (no ×100 / ÷100).
   * Similarly price_items[].sale_price is forwarded verbatim. Pure test on
   * parsePriceItems result values vs input values.
   */

  it('parsePriceItems preserves sale_price values verbatim (no ×100 / ÷100)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sale_date: fc.integer({ min: 2024, max: 2030 }).chain((y) =>
              fc.integer({ min: 1, max: 12 }).chain((m) =>
                fc.integer({ min: 1, max: 28 }).map((d) =>
                  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
                ),
              ),
            ),
            sale_price: fc.double({ min: 0.01, max: 99999.99, noNaN: true, noDefaultInfinity: true }),
            breakfast_num: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 7 },
        ),
        (items) => {
          const raw = JSON.stringify(items);
          const result = parsePriceItems(raw);

          // Each sale_price in the result must exactly equal the input — no conversion
          for (let i = 0; i < items.length; i++) {
            expect(result[i].sale_price).toBe(items[i].sale_price);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('create-order body total_amount equals --total-amount exactly (no minor-unit conversion)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.01, max: 99999.99, noNaN: true, noDefaultInfinity: true }),
        async (amount) => {
          const api = mockApiClient({ '/hotel/create-order': { order_id: 'o1', fc_order_code: 'fc1', order_status: 'AWAITING_PAYMENT', total_amount: amount, currency: 'CNY', rooms: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          const salePrice = amount; // use same amount for simplicity
          const priceItems = JSON.stringify([{ sale_date: '2026-07-01', sale_price: salePrice, breakfast_num: 0 }]);

          await program.parseAsync([
            ...BASE, 'create-order',
            '--api-key', 'k',
            '--product-token', 'tok1',
            '--total-amount', String(amount),
            '--currency', 'CNY',
            '--price-items', priceItems,
            '--check-in', '2026-07-01',
            '--check-out', '2026-07-02',
            '--guest-name', 'Bob',
            '--contact-name', 'Bob',
            '--contact-phone', '9876543210',
            '--idempotency-key', 'key-amt-test',
            '--yes',
            '--format', 'json',
          ]);

          const body = api.post.mock.calls[0][2] as Record<string, unknown>;
          // total_amount in body equals the input exactly — NO ×100 / ÷100
          expect(body.total_amount).toBe(amount);
          // price_items forwarded verbatim as well
          const bodyItems = body.price_items as Array<{ sale_price: number }>;
          expect(bodyItems[0].sale_price).toBe(salePrice);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 7: payment-order-id guard removed (no longer applicable)
// The --payment-order-id flag existed only on the old book verb which has been
// replaced by create-order (no payment-order-id flag). Property 7 is obsolete.
// ============================================================

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 8: Idempotency-key resolution safe + never fabricated
// Validates: Requirements 13.1, 13.2, 13.3, 13.5
// ============================================================

describe('PBT — Property 8: Idempotency-key resolution is safe and never fabricated', () => {
  /**
   * For valid keys [A-Za-z0-9_-]{1,128} → accepted; for invalid keys →
   * PARAM_INVALID; under --yes without a key → PARAM_IDEMPOTENCY_KEY_REQUIRED;
   * the key never appears in the body, always in the header.
   */

  it('valid keys [A-Za-z0-9_-]{1,128} are accepted in the Idempotency-Key header', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid keys but exclude those starting with '--' which
        // commander would interpret as an option flag when passed via argv.
        fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/).filter((s) => !s.startsWith('-')),
        async (validKey) => {
          const api = mockApiClient({ '/hotel/create-order': { order_id: 'o1', fc_order_code: 'fc1', order_status: 'AWAITING_PAYMENT', total_amount: 100, currency: 'CNY', rooms: [] } });
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          await program.parseAsync([
            ...BASE, 'create-order',
            '--api-key', 'k',
            '--product-token', 'tok1',
            '--total-amount', '100',
            '--currency', 'CNY',
            '--price-items', '[{"sale_date":"2026-07-01","sale_price":100,"breakfast_num":0}]',
            '--check-in', '2026-07-01',
            '--check-out', '2026-07-02',
            '--guest-name', 'Alice',
            '--contact-name', 'Alice',
            '--contact-phone', '1234567890',
            '--idempotency-key', validKey,
            '--yes',
            '--format', 'json',
          ]);

          expect(api.post).toHaveBeenCalledTimes(1);
          const [, , body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, unknown>, Record<string, string>];

          // Key is in the header
          expect(headers['Idempotency-Key']).toBe(validKey);
          // Key is NEVER in the body
          expect(body).not.toHaveProperty('Idempotency-Key');
          expect(body).not.toHaveProperty('idempotency_key');
          expect(body).not.toHaveProperty('idempotencyKey');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('invalid keys (empty, >128, bad chars) → PARAM_INVALID + 0 API calls', async () => {
    const invalidKey = fc.oneof(
      fc.constant(''),
      fc.integer({ min: 129, max: 256 }).map((n) => 'a'.repeat(n)),
      fc.tuple(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/),
        fc.constantFrom(' ', '!', '@', '#', '/', '\\', '\t', '\n', '~', '^'),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/),
      ).map(([a, b, c]) => `${a}${b}${c}`),
    );

    await fc.assert(
      fc.asyncProperty(invalidKey, async (badKey) => {
        const api = mockApiClient();
        const program = hotelProgram(api);
        captureStdout();
        captureStderr();

        let caught: unknown;
        try {
          await program.parseAsync([
            ...BASE, 'create-order',
            '--api-key', 'k',
            '--product-token', 'tok1',
            '--total-amount', '100',
            '--currency', 'CNY',
            '--price-items', '[{"sale_date":"2026-07-01","sale_price":100,"breakfast_num":0}]',
            '--check-in', '2026-07-01',
            '--check-out', '2026-07-02',
            '--guest-name', 'Alice',
            '--contact-name', 'Alice',
            '--contact-phone', '1234567890',
            '--idempotency-key', badKey,
            '--yes',
            '--format', 'json',
          ]);
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(CliError);
        expect((caught as CliError).code).toBe('PARAM_INVALID');
        expect(api.post).not.toHaveBeenCalled();
        expect(api.get).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('--yes without --idempotency-key → PARAM_IDEMPOTENCY_KEY_REQUIRED + 0 API calls', async () => {
    // This tests with arbitrary create-order parameters (valid ones) but missing the key
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 1, max: 9999, noNaN: true, noDefaultInfinity: true }),
        async (amount) => {
          const api = mockApiClient();
          const program = hotelProgram(api);
          captureStdout();
          captureStderr();

          let caught: unknown;
          try {
            await program.parseAsync([
              ...BASE, 'create-order',
              '--api-key', 'k',
              '--product-token', 'tok1',
              '--total-amount', String(amount),
              '--currency', 'USD',
              '--price-items', `[{"sale_date":"2026-07-01","sale_price":${amount},"breakfast_num":0}]`,
              '--check-in', '2026-07-01',
              '--check-out', '2026-07-02',
              '--guest-name', 'Bob',
              '--contact-name', 'Bob',
              '--contact-phone', '5551234',
              '--yes',
              '--format', 'json',
              // NOTE: --idempotency-key intentionally OMITTED
            ]);
          } catch (e) {
            caught = e;
          }

          expect(caught).toBeInstanceOf(CliError);
          expect((caught as CliError).code).toBe('PARAM_IDEMPOTENCY_KEY_REQUIRED');
          expect(api.post).not.toHaveBeenCalled();
          expect(api.get).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Feature: merchant-cli-hotel-redaug, Property 12: Error-code preservation and auth/exit mapping
// Validates: Requirements 10.3, 10.4, 12.3, 12.4
// ============================================================

import { exitCodeFor } from '@agenzo/cli-core';

describe('PBT — Property 12: Error-code preservation and auth/exit mapping', () => {
  /**
   * Feed generated ApiError-like responses (varying HTTP status and error_code)
   * through CliError.fromApi + exitCodeFor:
   *
   * - Known hotel catalog codes are preserved (NOT downgraded to HTTP mapping).
   * - HTTP 401 (under api-key auth) without a known code → KEY_INVALID.
   * - HTTP 403 without a known code → KEY_SCOPE_DENIED.
   * - exitCodeFor returns the matrix: hotel business codes → 1, KEY_* → 3,
   *   UPSTREAM_ERROR/INTERNAL_ERROR/RATE_LIMITED → 4, CLIENT_ABORTED → 5.
   */

  const KNOWN_HOTEL_CODES = [
    'NO_AVAILABILITY',
    'PRICE_CHANGED',
    'NAME_FORMAT_INVALID',
    'HOTEL_ORDER_NOT_FOUND',
    'ALREADY_CANCELLED',
    'CHECKOUT_NOT_ALLOWED',
    'CHECKOUT_TASK_NOT_FOUND',
    'PAY_PER_CALL_NOT_AVAILABLE',
  ] as const;

  it('known hotel catalog codes are preserved (not downgraded to HTTP-status mapping)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KNOWN_HOTEL_CODES),
        fc.constantFrom(400, 404, 409, 410, 422, 500, 502, 503),
        async (knownCode, httpStatus) => {
          const apiError = {
            success: false as const,
            errorCode: 9999,
            errorMessage: 'some error',
            statusCode: httpStatus,
            code: knownCode,
          };

          const err = CliError.fromApi(apiError, { auth: 'api-key' });

          // The CliError code MUST be the known string code, NOT a generic HTTP mapping
          expect(err.code).toBe(knownCode);
          // Hotel business codes always exit 1
          expect(exitCodeFor(err)).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HTTP 401 (api-key auth) without a known code → KEY_INVALID (exit 3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 9999 }),
        async (errorCode) => {
          const apiError = {
            success: false as const,
            errorCode,
            errorMessage: 'unauthorized',
            statusCode: 401,
            // No known string code
          };

          const err = CliError.fromApi(apiError, { auth: 'api-key' });

          expect(err.code).toBe('KEY_INVALID');
          expect(exitCodeFor(err)).toBe(3);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HTTP 403 (api-key auth) without a known code → KEY_SCOPE_DENIED (exit 3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 9999 }),
        async (errorCode) => {
          const apiError = {
            success: false as const,
            errorCode,
            errorMessage: 'forbidden',
            statusCode: 403,
            // No known string code
          };

          const err = CliError.fromApi(apiError, { auth: 'api-key' });

          expect(err.code).toBe('KEY_SCOPE_DENIED');
          expect(exitCodeFor(err)).toBe(3);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('exitCodeFor maps correctly: KEY_* → 3, UPSTREAM/INTERNAL/RATE_LIMITED → 4, CLIENT_ABORTED → 5, hotel codes → 1', async () => {
    // Build a mapping of codes to expected exit codes
    const codeExitPairs: Array<[string, number]> = [
      // Hotel business codes → exit 1
      ...KNOWN_HOTEL_CODES.map((c): [string, number] => [c, 1]),
      // Auth/key codes → exit 3
      ['KEY_INVALID', 3],
      ['KEY_SCOPE_DENIED', 3],
      // Network/server codes → exit 4
      ['UPSTREAM_ERROR', 4],
      ['INTERNAL_ERROR', 4],
      ['RATE_LIMITED', 4],
      // User cancel → exit 5
      ['CLIENT_ABORTED', 5],
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...codeExitPairs),
        async ([code, expectedExit]) => {
          const err = new CliError(code as never, 'test message');
          expect(exitCodeFor(err)).toBe(expectedExit);
        },
      ),
      { numRuns: 100 },
    );
  });
});

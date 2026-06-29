import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerHotelSearchCommand } from '../src/hotel-redaug/search.js';
import { registerHotelQuoteCommand } from '../src/hotel-redaug/quote.js';
import { registerHotelBookCommand } from '../src/hotel-redaug/book.js';
import { registerHotelGetCommand } from '../src/hotel-redaug/get.js';
import { registerHotelCancelCommand } from '../src/hotel-redaug/cancel.js';
import { registerHotelCheckoutCommand } from '../src/hotel-redaug/checkout.js';
import { registerHotelGetCheckoutCommand } from '../src/hotel-redaug/get-checkout.js';
import { registerHotelListOrdersCommand } from '../src/hotel-redaug/list-orders.js';
import { registerHotelFindDestinationCommand } from '../src/hotel-redaug/find-destination.js';
import { registerHotelFiltersCommand } from '../src/hotel-redaug/hotel-filters.js';
import { registerHotelListCitiesCommand } from '../src/hotel-redaug/list-cities.js';
import { registerHotelDetailCommand } from '../src/hotel-redaug/hotel-detail.js';
import { buildProgram, mockApiClient } from './helpers.js';

// Mock prompts to avoid TTY issues in tests
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// Helper: build the hotel-redaug noun with all 12 verbs registered
// ============================================================

function buildHotelProgram() {
  const program = buildProgram();
  const deps = { apiClient: mockApiClient() };
  const hotelCmd = program.command('hotel-redaug').description('Hotel booking (Redaug)');
  registerHotelSearchCommand(hotelCmd, deps);
  registerHotelQuoteCommand(hotelCmd, deps);
  registerHotelBookCommand(hotelCmd, deps);
  registerHotelGetCommand(hotelCmd, deps);
  registerHotelCancelCommand(hotelCmd, deps);
  registerHotelCheckoutCommand(hotelCmd, deps);
  registerHotelGetCheckoutCommand(hotelCmd, deps);
  registerHotelListOrdersCommand(hotelCmd, deps);
  registerHotelFindDestinationCommand(hotelCmd, deps);
  registerHotelFiltersCommand(hotelCmd, deps);
  registerHotelListCitiesCommand(hotelCmd, deps);
  registerHotelDetailCommand(hotelCmd, deps);
  return { program, hotelCmd };
}

/**
 * Run a verb with `--help --format json` and capture the emitted schema JSON.
 * `attachSchemaHelp` calls `console.log(JSON.stringify(schema, null, 2))`, so
 * we spy on `console.log` to capture the output.
 */
async function getVerbSchema(verb: string): Promise<Record<string, unknown>> {
  const { program } = buildHotelProgram();
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });

  // wantsJsonSchema reads process.argv, so we must set it
  const savedArgv = process.argv;
  process.argv = ['node', 'cli', 'hotel-redaug', verb, '--help', '--format', 'json'];

  try {
    await program.parseAsync(['node', 'cli', 'hotel-redaug', verb, '--help', '--format', 'json']);
  } catch {
    // commander may throw on --help (exitOverride); this is fine
  }

  process.argv = savedArgv;

  expect(lines.length).toBeGreaterThanOrEqual(1);
  const parsed = JSON.parse(lines[0]);
  return parsed;
}

// ============================================================
// Task 6.6 — Verb-schema tests (`--help --format json`)
// ============================================================

describe('hotel-redaug verb schema (--help --format json)', () => {
  const ALL_VERBS = [
    'search',
    'quote',
    'book',
    'get',
    'cancel',
    'checkout',
    'get-checkout',
    'list-orders',
    'find-destination',
    'hotel-filters',
    'list-cities',
    'hotel-detail',
  ];

  describe.each(ALL_VERBS)('%s emits a valid JSON schema', (verb) => {
    it(`${verb} schema has all required top-level keys`, async () => {
      const schema = await getVerbSchema(verb);
      for (const key of ['cli', 'noun', 'verb', 'description', 'flags', 'response', 'example']) {
        expect(schema).toHaveProperty(key);
      }
      expect(schema.cli).toBe('agenzo-merchant-cli');
      expect(schema.noun).toBe('hotel-redaug');
      expect(schema.verb).toBe(verb);
    });
  });

  describe('polling block on long-running verbs', () => {
    it('get schema carries a polling block with recommended_interval_seconds, terminal_statuses, in_progress_statuses', async () => {
      const schema = await getVerbSchema('get');
      expect(schema).toHaveProperty('polling');
      const polling = schema.polling as Record<string, unknown>;
      expect(polling.recommended_interval_seconds).toBe(5);
      expect(polling.terminal_statuses).toEqual([3, 4, 5]);
      expect(polling.in_progress_statuses).toEqual([2]);
    });

    it('get-checkout schema carries a polling block with recommended_interval_seconds, terminal_statuses, in_progress_statuses', async () => {
      const schema = await getVerbSchema('get-checkout');
      expect(schema).toHaveProperty('polling');
      const polling = schema.polling as Record<string, unknown>;
      expect(polling.recommended_interval_seconds).toBe(10);
      expect(polling.terminal_statuses).toEqual(['approved', 'rejected', 'refunded']);
      expect(polling.in_progress_statuses).toEqual(['pending']);
    });
  });

  describe('error_recovery on write and long-running verbs', () => {
    it('book schema carries an error_recovery map', async () => {
      const schema = await getVerbSchema('book');
      expect(schema).toHaveProperty('error_recovery');
      const recovery = schema.error_recovery as Record<string, string>;
      expect(recovery).toHaveProperty('BILLING_MODE_MISMATCH');
      expect(recovery).toHaveProperty('NO_AVAILABILITY');
      expect(recovery).toHaveProperty('PARAM_IDEMPOTENCY_KEY_REQUIRED');
    });

    it('cancel schema carries an error_recovery map', async () => {
      const schema = await getVerbSchema('cancel');
      expect(schema).toHaveProperty('error_recovery');
      const recovery = schema.error_recovery as Record<string, string>;
      expect(recovery).toHaveProperty('CANCELLATION_NOT_ALLOWED');
      expect(recovery).toHaveProperty('ALREADY_CANCELLED');
    });

    it('checkout schema carries an error_recovery map', async () => {
      const schema = await getVerbSchema('checkout');
      expect(schema).toHaveProperty('error_recovery');
      const recovery = schema.error_recovery as Record<string, string>;
      expect(recovery).toHaveProperty('CHECKOUT_NOT_ALLOWED');
      expect(recovery).toHaveProperty('PARAM_IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('search schema flags include both destination-id and lat/lng', () => {
    it('hotelSearchSchema.flags includes destination-id, lat, and lng', async () => {
      const schema = await getVerbSchema('search');
      const flags = schema.flags as Record<string, unknown>;
      expect(flags).toHaveProperty('destination-id');
      expect(flags).toHaveProperty('lat');
      expect(flags).toHaveProperty('lng');
    });
  });

  describe('bare --help and --help --format table do NOT emit JSON', () => {
    it('bare --help does not emit JSON schema (falls through to text help)', async () => {
      const { program } = buildHotelProgram();
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });

      const savedArgv = process.argv;
      process.argv = ['node', 'cli', 'hotel-redaug', 'search', '--help'];

      try {
        await program.parseAsync(['node', 'cli', 'hotel-redaug', 'search', '--help']);
      } catch {
        // commander throws on exitOverride with --help
      }

      process.argv = savedArgv;

      // No JSON schema should have been emitted via console.log
      const jsonLines = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' && 'cli' in parsed;
        } catch {
          return false;
        }
      });
      expect(jsonLines).toHaveLength(0);
    });

    it('--help --format table does not emit JSON schema', async () => {
      const { program } = buildHotelProgram();
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });

      const savedArgv = process.argv;
      process.argv = ['node', 'cli', 'hotel-redaug', 'search', '--help', '--format', 'table'];

      try {
        await program.parseAsync([
          'node', 'cli', 'hotel-redaug', 'search', '--help', '--format', 'table',
        ]);
      } catch {
        // commander throws on exitOverride with --help
      }

      process.argv = savedArgv;

      // No JSON schema should have been emitted
      const jsonLines = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' && 'cli' in parsed;
        } catch {
          return false;
        }
      });
      expect(jsonLines).toHaveLength(0);
    });
  });
});

// ============================================================
// Task 6.7 — Registration test
// ============================================================

describe('hotel-redaug noun registration', () => {
  it('hotel-redaug has exactly 12 registered subcommands', () => {
    const { hotelCmd } = buildHotelProgram();
    const subcommandNames = hotelCmd.commands.map((cmd: Command) => cmd.name());
    expect(subcommandNames).toHaveLength(12);
  });

  it('hotel-redaug registers all 12 expected verbs', () => {
    const { hotelCmd } = buildHotelProgram();
    const subcommandNames = hotelCmd.commands.map((cmd: Command) => cmd.name());
    const expected = [
      'search',
      'quote',
      'book',
      'get',
      'cancel',
      'checkout',
      'get-checkout',
      'list-orders',
      'find-destination',
      'hotel-filters',
      'list-cities',
      'hotel-detail',
    ];
    for (const verb of expected) {
      expect(subcommandNames).toContain(verb);
    }
  });

  it('find-destination IS registered (Addendum A reversed the exclusion)', () => {
    const { hotelCmd } = buildHotelProgram();
    const subcommandNames = hotelCmd.commands.map((cmd: Command) => cmd.name());
    expect(subcommandNames).toContain('find-destination');
  });

  it('no host/profile/config subcommand exists', () => {
    const { hotelCmd } = buildHotelProgram();
    const subcommandNames = hotelCmd.commands.map((cmd: Command) => cmd.name());
    expect(subcommandNames).not.toContain('host');
    expect(subcommandNames).not.toContain('profile');
    expect(subcommandNames).not.toContain('config');
  });
});

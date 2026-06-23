import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  wantsJsonSchema,
  emitSchema,
  quoteSchema,
  bookSchema,
  rideGetSchema,
  cancelSchema,
  listOrdersSchema,
} from '../src/verb-schema.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// verb-schema `--help --format json` — §4.6 UT-SCHEMA-01..07
// (Req 7.1 / Property 7; book flags absent payment-method-id → Property 5)
// ============================================================

describe('wantsJsonSchema (argv detection)', () => {
  it('UT-SCHEMA-01: --help --format json (space form) → true', () => {
    expect(
      wantsJsonSchema(['node', 'cli', 'ride-elife', 'quote', '--help', '--format', 'json']),
    ).toBe(true);
  });

  it('UT-SCHEMA-02: --format=json (equals form) → true', () => {
    expect(
      wantsJsonSchema(['node', 'cli', 'ride-elife', 'quote', '--help', '--format=json']),
    ).toBe(true);
  });

  it('UT-SCHEMA-03: bare --help → false (text help kept; program json default not in argv)', () => {
    expect(wantsJsonSchema(['node', 'cli', 'ride-elife', 'quote', '--help'])).toBe(false);
  });

  it('UT-SCHEMA-04: --help --format table → false', () => {
    expect(
      wantsJsonSchema(['node', 'cli', 'ride-elife', 'quote', '--help', '--format', 'table']),
    ).toBe(false);
  });
});

describe('emitSchema', () => {
  it('UT-SCHEMA-05: prints a single pretty JSON object that round-trips with the verb fields', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    emitSchema(quoteSchema);

    expect(lines).toHaveLength(1);
    const raw = lines[0];
    // Pretty-printed (multi-line, 2-space indent).
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['cli', 'noun', 'verb', 'description', 'flags', 'response', 'example']) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.cli).toBe('agenzo-merchant-cli');
    expect(parsed.noun).toBe('ride-elife');
    expect(parsed.verb).toBe('quote');
  });
});

describe('verb schema field alignment', () => {
  it('UT-SCHEMA-06: required flags / defaults align; book has NO payment-method-id (Property 5); get terminal_statuses = 5', () => {
    // quote: pickup-lat required.
    expect(quoteSchema.flags['pickup-lat'].required).toBe(true);

    // book: idempotency-key required; price-currency default USD.
    expect(bookSchema.flags['idempotency-key'].required).toBe(true);
    expect(bookSchema.flags['price-currency'].default).toBe('USD');

    // Property 5: book flags carry NO payment-method-id (nor any card field).
    expect(bookSchema.flags).not.toHaveProperty('payment-method-id');
    expect(bookSchema.flags).not.toHaveProperty('card-number');
    expect(bookSchema.flags).not.toHaveProperty('cvv');
    // pay_per_call's optional handle is the only payment field, and it's conditional.
    expect(bookSchema.flags['payment-order-id'].required).toBe('conditional');

    // get: exactly the 5 case-sensitive terminal statuses.
    expect(rideGetSchema.polling?.terminal_statuses).toEqual([
      'At destination',
      'Cancelled',
      'Rejected',
      'Customer no show',
      'Driver no show',
    ]);
    expect(rideGetSchema.polling?.terminal_statuses).toHaveLength(5);
  });

  it('UT-SCHEMA-07: only get carries polling; book/cancel carry the idempotency error_recovery hint', () => {
    // Read verbs (quote / list-orders) have no polling block.
    expect(quoteSchema.polling).toBeUndefined();
    expect(listOrdersSchema.polling).toBeUndefined();
    // get is the status-query verb → has polling guidance.
    expect(rideGetSchema.polling).toBeDefined();

    // Write verbs surface the idempotency-required recovery hint.
    expect(bookSchema.error_recovery).toHaveProperty('PARAM_IDEMPOTENCY_KEY_REQUIRED');
    expect(cancelSchema.error_recovery).toHaveProperty('PARAM_IDEMPOTENCY_KEY_REQUIRED');

    // Sanity: each schema names the merchant CLI + ride-elife noun verbatim.
    for (const s of [quoteSchema, bookSchema, rideGetSchema, cancelSchema, listOrdersSchema]) {
      expect(s.cli).toBe('agenzo-merchant-cli');
      expect(s.noun).toBe('ride-elife');
    }
  });
});

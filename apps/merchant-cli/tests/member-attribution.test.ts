/**
 * `--member <id>` attribution across the 7 order verbs (3 writes + 4 lists).
 *
 * Locks the three invariants from `doc/member-id-attribution-design.md`:
 *  1. supplied non-empty  → forwarded (body `member_id` on write, query
 *     `member_id` on list);
 *  2. absent or blank     → the field is omitted ENTIRELY (never `""`, never
 *     `null`) so the platform stores an unattributed order and its sparse
 *     member index stays clean;
 *  3. the verb schema marks the flag `source: 'session'` so LLM tool-schema
 *     builders hide it — the value comes from the authenticated session, not
 *     from the model.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerBookCommand } from '../src/ride-elife/book.js';
import { registerListOrdersCommand as registerRideListOrders } from '../src/ride-elife/list-orders.js';
import { registerHotelCreateOrderCommand } from '../src/hotel-redaug/create-order.js';
import { registerHotelListOrdersCommand } from '../src/hotel-redaug/list-orders.js';
import { registerCreateOrderCommand as registerFlightCreateOrder } from '../src/flight-flink/create-order.js';
import { registerListOrdersCommand as registerFlightListOrders } from '../src/flight-flink/list-orders.js';
import { registerOrdersListCommand } from '../src/orders/list.js';
import {
  bookSchema,
  listOrdersSchema,
  hotelCreateOrderSchema,
  hotelListOrdersSchema,
  flightCreateOrderSchema,
  flightListOrdersSchema,
  unifiedOrdersListSchema,
} from '../src/verb-schema.js';
import { memberIdOf } from '../src/member.js';
import { buildProgram, captureStdout, captureStderr } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

/** Mock ApiClient recording every get/post call (substring path match). */
function recordingApi() {
  const get = vi.fn().mockResolvedValue({ success: true, data: { orders: [], total: 0 } });
  const post = vi.fn().mockResolvedValue({ success: true, data: { order_id: 'x', order_no: 'x', total_amount: 1, currency: 'USD' } });
  return { get, post };
}

const MEMBER = 'usr_9f3a@example.com';

// ── Write verbs ────────────────────────────────────────────────────────────

const RIDE_BOOK_ARGS = [
  'node', 'cli', 'ride-elife', 'book',
  '--api-key', 'k', '--yes', '--format', 'json',
  '--quote-id', 'q1', '--vehicle-class', 'Sedan', '--price-amount', '42.5',
  '--passenger-name', 'Jane Doe', '--passenger-phone', '+14155551234',
  '--passenger-email', 'jane@example.com',
  '--idempotency-key', 'idem-1',
];

const HOTEL_CREATE_ARGS = [
  'node', 'cli', 'hotel-redaug', 'create-order',
  '--api-key', 'k', '--yes', '--format', 'json',
  '--product-token', 'pt1', '--total-amount', '100', '--currency', 'USD',
  '--price-items', '[{"sale_date":"2026-09-01","sale_price":100,"breakfast_num":0}]',
  '--check-in', '2026-09-01', '--check-out', '2026-09-02',
  '--guest-name', 'Jane Doe', '--contact-name', 'Jane Doe', '--contact-phone', '13800000000',
  '--idempotency-key', 'idem-1',
];

const FLIGHT_CREATE_ARGS = [
  'node', 'cli', 'flight-flink', 'create-order',
  '--api-key', 'k', '--yes', '--format', 'json',
  '--product-token', 'pt1', '--total-amount', '1200', '--currency', 'CNY',
  '--contact-name', 'Jane', '--contact-region', '86', '--contact-phone', '13800000000',
  '--contact-email', 'jane@example.com',
  '--passengers', '[{"passenger_name":"Jane","gender":"1","id_type":"1"}]',
  '--idempotency-key', 'idem-1',
];

const WRITE_CASES = [
  {
    name: 'ride-elife book',
    args: RIDE_BOOK_ARGS,
    build: (api: ApiClient) => {
      const program = buildProgram();
      registerBookCommand(program.command('ride-elife'), { apiClient: api });
      return program;
    },
  },
  {
    name: 'hotel-redaug create-order',
    args: HOTEL_CREATE_ARGS,
    build: (api: ApiClient) => {
      const program = buildProgram();
      registerHotelCreateOrderCommand(program.command('hotel-redaug'), { apiClient: api });
      return program;
    },
  },
  {
    name: 'flight-flink create-order',
    args: FLIGHT_CREATE_ARGS,
    build: (api: ApiClient) => {
      const program = buildProgram();
      registerFlightCreateOrder(program.command('flight-flink'), { apiClient: api });
      return program;
    },
  },
] as const;

describe('member attribution — write verbs', () => {
  for (const c of WRITE_CASES) {
    it(`${c.name}: --member is forwarded as body.member_id`, async () => {
      const api = recordingApi();
      captureStdout();
      captureStderr();
      await c.build(api as unknown as ApiClient).parseAsync([...c.args, '--member', MEMBER]);

      const body = api.post.mock.calls[0][2] as Record<string, unknown>;
      expect(body.member_id).toBe(MEMBER);
    });

    it(`${c.name}: omitted --member leaves member_id absent from the body`, async () => {
      const api = recordingApi();
      captureStdout();
      captureStderr();
      await c.build(api as unknown as ApiClient).parseAsync([...c.args]);

      const body = api.post.mock.calls[0][2] as Record<string, unknown>;
      expect('member_id' in body).toBe(false);
    });

    it(`${c.name}: blank --member is treated as absent, not sent as ""`, async () => {
      const api = recordingApi();
      captureStdout();
      captureStderr();
      await c.build(api as unknown as ApiClient).parseAsync([...c.args, '--member', '   ']);

      const body = api.post.mock.calls[0][2] as Record<string, unknown>;
      expect('member_id' in body).toBe(false);
    });
  }
});

// ── List verbs ─────────────────────────────────────────────────────────────

describe('member attribution — list verbs', () => {
  it('ride-elife list-orders: --member becomes the member_id query param', async () => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerRideListOrders(program.command('ride-elife'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync(['node', 'cli', 'ride-elife', 'list-orders', '--api-key', 'k', '--member', MEMBER]);

    const params = api.get.mock.calls[0][2] as Record<string, string>;
    expect(params).toEqual({ page: '1', page_size: '20', member_id: MEMBER });
  });

  it('hotel-redaug list-orders: --member becomes the member_id query param', async () => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerHotelListOrdersCommand(program.command('hotel-redaug'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync(['node', 'cli', 'hotel-redaug', 'list-orders', '--api-key', 'k', '--member', MEMBER]);

    const params = api.get.mock.calls[0][2] as Record<string, string>;
    expect(params.member_id).toBe(MEMBER);
  });

  it('orders list: --member becomes the member_id query param', async () => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerOrdersListCommand(program.command('orders'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync(['node', 'cli', 'orders', 'list', '--api-key', 'k', '--member', MEMBER]);

    const params = api.get.mock.calls[0][2] as Record<string, string>;
    expect(params.member_id).toBe(MEMBER);
  });

  it('flight-flink list-orders: --member is encoded into the query string', async () => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerFlightListOrders(program.command('flight-flink'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync(['node', 'cli', 'flight-flink', 'list-orders', '--api-key', 'k', '--member', MEMBER]);

    const path = api.get.mock.calls[0][0] as string;
    expect(path).toContain(`member_id=${encodeURIComponent(MEMBER)}`);
  });

  it('list verbs omit member_id entirely when --member is absent', async () => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerRideListOrders(program.command('ride-elife'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync(['node', 'cli', 'ride-elife', 'list-orders', '--api-key', 'k']);

    const params = api.get.mock.calls[0][2] as Record<string, string>;
    expect('member_id' in params).toBe(false);
  });
});

// ── Schema contract ────────────────────────────────────────────────────────

describe('member attribution — verb schema', () => {
  const schemas = {
    'ride-elife book': bookSchema,
    'ride-elife list-orders': listOrdersSchema,
    'hotel-redaug create-order': hotelCreateOrderSchema,
    'hotel-redaug list-orders': hotelListOrdersSchema,
    'flight-flink create-order': flightCreateOrderSchema,
    'flight-flink list-orders': flightListOrdersSchema,
    'orders list': unifiedOrdersListSchema,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}: declares an optional member flag sourced from the session`, () => {
      const flag = schema.flags.member;
      expect(flag, `${name} must declare a member flag`).toBeDefined();
      expect(flag.required).toBe(false);
      // source: 'session' is what keeps the flag out of LLM tool schemas.
      expect(flag.source).toBe('session');
    });
  }
});

describe('memberIdOf', () => {
  it('trims, and maps missing / blank / non-string to undefined', () => {
    expect(memberIdOf({ member: ` ${MEMBER} ` })).toBe(MEMBER);
    expect(memberIdOf({})).toBeUndefined();
    expect(memberIdOf({ member: '' })).toBeUndefined();
    expect(memberIdOf({ member: '\t \n' })).toBeUndefined();
    expect(memberIdOf({ member: 42 })).toBeUndefined();
  });
});

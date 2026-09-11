/**
 * `--member <id>` on the 15 SINGLE-ORDER ADDRESSING verbs.
 *
 * Companion to `member-attribution.test.ts`, which covers the original 7 verbs
 * (3 writes + 4 lists). This file covers the batch added for stage 8a of
 * `doc/member-id-attribution-design.md` — the verbs that address ONE order by
 * its id, where the revised invariant 2 makes `member_id` part of the ownership
 * condition rather than a pure attribution label.
 *
 * Why these tests exist. Without them, deleting any single `member_id` injection
 * leaves every test green: the flag would still parse, the command would still
 * succeed, and the platform would silently fall back to `developer_id + org_id`
 * only — reopening exactly the hole stage 8 closes (A pays B's order by knowing
 * its id). One assertion per verb per direction is the cheapest guard that
 * actually fails when the wiring is removed.
 *
 * Three invariants, same as the companion file:
 *  1. supplied non-empty → forwarded (body `member_id` on POST, query
 *     `member_id` on GET);
 *  2. absent → the field is omitted ENTIRELY, so behaviour is byte-identical to
 *     before stage 8a for every existing caller;
 *  3. the verb schema marks the flag `source: 'session'` — the value comes from
 *     the authenticated session, never from the model.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerHotelPayOrderCommand } from '../src/hotel-redaug/pay-order.js';
import { registerHotelCancelCommand } from '../src/hotel-redaug/cancel.js';
import { registerHotelCheckoutCommand } from '../src/hotel-redaug/checkout.js';
import { registerHotelGetCommand } from '../src/hotel-redaug/get.js';
import { registerPayOrderCommand as registerFlightPayOrder } from '../src/flight-flink/pay-order.js';
import { registerCancelOrderCommand as registerFlightCancelOrder } from '../src/flight-flink/cancel-order.js';
import { registerChangeApplyCommand } from '../src/flight-flink/change-apply.js';
import { registerChangePayCommand } from '../src/flight-flink/change-pay.js';
import { registerRefundApplyCommand } from '../src/flight-flink/refund-apply.js';
import { registerGetOrderCommand as registerFlightGetOrder } from '../src/flight-flink/get-order.js';
import { registerCancelCommand as registerRideCancel } from '../src/ride-elife/cancel.js';
import { registerRideGetCommand } from '../src/ride-elife/get.js';
import { registerRideTripStatusCommand } from '../src/ride-elife/trip-status.js';
import { registerRideUpdateCommand } from '../src/ride-elife/update.js';
import { registerOrdersGetCommand } from '../src/orders/get.js';
import {
  hotelPayOrderSchema,
  hotelCancelSchema,
  hotelCheckoutSchema,
  hotelGetSchema,
  flightPayOrderSchema,
  flightCancelOrderSchema,
  flightChangeApplySchema,
  flightChangePaySchema,
  flightRefundApplySchema,
  flightGetOrderSchema,
  cancelSchema,
  rideGetSchema,
  rideTripStatusSchema,
  rideUpdateSchema,
  unifiedOrdersGetSchema,
} from '../src/verb-schema.js';
import { buildProgram, captureStdout, captureStderr } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

/** Mock ApiClient recording every get/post call. */
function recordingApi() {
  const data = {
    order_id: 'x',
    order_no: 'x',
    order_status: 'PAID',
    status: 'TICKETED',
    task_order_code: 't1',
    cancel_status: 'cancel_pending',
    total_amount: 1,
    currency: 'USD',
  };
  return {
    get: vi.fn().mockResolvedValue({ success: true, data }),
    post: vi.fn().mockResolvedValue({ success: true, data }),
  };
}

const MEMBER = 'usr_9f3a@example.com';
const BASE = ['--api-key', 'k', '--yes', '--format', 'json'] as const;

type Case = {
  name: string;
  args: string[];
  build: (api: ApiClient) => ReturnType<typeof buildProgram>;
};

function prog(
  noun: string,
  register: (parent: ReturnType<typeof buildProgram>, deps: { apiClient: ApiClient }) => void,
) {
  return (api: ApiClient) => {
    const program = buildProgram();
    register(program.command(noun) as never, { apiClient: api });
    return program;
  };
}

// ── POST verbs: member_id rides in the body ────────────────────────────────

const POST_CASES: Case[] = [
  {
    name: 'hotel-redaug pay-order',
    args: ['node', 'cli', 'hotel-redaug', 'pay-order', ...BASE,
      '--order-id', 'hho_1', '--idempotency-key', 'i1'],
    build: prog('hotel-redaug', registerHotelPayOrderCommand as never),
  },
  {
    name: 'hotel-redaug cancel',
    args: ['node', 'cli', 'hotel-redaug', 'cancel', ...BASE,
      '--order-id', 'hho_1', '--fc-order-code', 'fc1', '--idempotency-key', 'i1'],
    build: prog('hotel-redaug', registerHotelCancelCommand as never),
  },
  {
    name: 'hotel-redaug checkout',
    args: ['node', 'cli', 'hotel-redaug', 'checkout', ...BASE,
      '--order-id', 'hho_1', '--fc-order-code', 'fc1', '--reason', 'r',
      '--checkout-rooms',
      '[{"room_index":"1","guest_name":"Jane Doe","cancel_check_in_date":"2026-09-01"}]',
      '--idempotency-key', 'i1'],
    build: prog('hotel-redaug', registerHotelCheckoutCommand as never),
  },
  {
    name: 'flight-flink pay-order',
    args: ['node', 'cli', 'flight-flink', 'pay-order', ...BASE,
      '--order-no', 'ffo_1', '--idempotency-key', 'i1'],
    build: prog('flight-flink', registerFlightPayOrder as never),
  },
  {
    name: 'flight-flink cancel-order',
    args: ['node', 'cli', 'flight-flink', 'cancel-order', ...BASE,
      '--order-no', 'ffo_1', '--idempotency-key', 'i1'],
    build: prog('flight-flink', registerFlightCancelOrder as never),
  },
  {
    name: 'flight-flink change-apply',
    args: ['node', 'cli', 'flight-flink', 'change-apply', ...BASE,
      '--order-no', 'ffo_1', '--passenger', 'Jane', '--segment-id', 's1',
      '--product-token', 'pt1', '--contact-name', 'Jane', '--contact-region', '86',
      '--contact-phone', '13800000000', '--contact-email', 'jane@example.com',
      '--idempotency-key', 'i1'],
    build: prog('flight-flink', registerChangeApplyCommand as never),
  },
  {
    name: 'flight-flink change-pay',
    args: ['node', 'cli', 'flight-flink', 'change-pay', ...BASE,
      '--order-no', 'ffo_1', '--change-order-no', 'chg_1', '--currency', 'CNY',
      '--amount', '120', '--idempotency-key', 'i1'],
    build: prog('flight-flink', registerChangePayCommand as never),
  },
  {
    name: 'flight-flink refund-apply',
    args: ['node', 'cli', 'flight-flink', 'refund-apply', ...BASE,
      '--order-no', 'ffo_1', '--passenger', 'Jane', '--segment-id', 's1',
      '--reason-type', '1',
      '--contact-name', 'Jane', '--contact-region', '86',
      '--contact-phone', '13800000000', '--contact-email', 'jane@example.com',
      '--idempotency-key', 'i1'],
    build: prog('flight-flink', registerRefundApplyCommand as never),
  },
  {
    name: 'ride-elife update',
    args: ['node', 'cli', 'ride-elife', 'update', ...BASE,
      '--order-id', 'rio_1', '--luggage-count', '2', '--idempotency-key', 'i1'],
    build: prog('ride-elife', registerRideUpdateCommand as never),
  },
];

describe('member on single-order addressing — POST verbs', () => {
  for (const c of POST_CASES) {
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
      await c.build(api as unknown as ApiClient).parseAsync(c.args);

      const body = (api.post.mock.calls[0][2] ?? {}) as Record<string, unknown>;
      expect('member_id' in body).toBe(false);
    });
  }
});

// ── ride-elife cancel: POST whose contract is "no body at all" ─────────────

describe('member on single-order addressing — ride-elife cancel', () => {
  const ARGS = ['node', 'cli', 'ride-elife', 'cancel', ...BASE,
    '--order-id', 'rio_1', '--idempotency-key', 'i1'];
  const build = prog('ride-elife', registerRideCancel as never);

  it('--member is forwarded as body.member_id', async () => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    await build(api as unknown as ApiClient).parseAsync([...ARGS, '--member', MEMBER]);

    expect(api.post.mock.calls[0][2]).toEqual({ member_id: MEMBER });
  });

  it('omitted --member keeps the body undefined, not an empty object', async () => {
    // This verb's contract is "Idempotency-Key in the header, NO body"
    // (ride-elife.test.ts TC-CANCEL-01/02 and ride-compatibility.test.ts both
    // pin it). Invariant 3 — "not supplied means not present" — means an absent
    // member must not conjure a `{}` body either.
    const api = recordingApi();
    captureStdout();
    captureStderr();
    await build(api as unknown as ApiClient).parseAsync(ARGS);

    expect(api.post.mock.calls[0][2]).toBeUndefined();
  });
});

// ── ride-elife update: member must not count as an updatable field ─────────

describe('member on single-order addressing — ride-elife update field counting', () => {
  const build = prog('ride-elife', registerRideUpdateCommand as never);

  it('--member alone is still "nothing to update"', async () => {
    // `update` decides whether there is anything to change by counting body
    // keys (`Object.keys(body).length === 0` → PARAM_INVALID), and the confirm
    // prompt reports that same count as "N change(s)". member is an ownership /
    // attribution label, NOT an updatable field, so it must be injected AFTER
    // both. Injecting it earlier makes `--member` alone look like a valid
    // update and burns an idempotency key on a request that changes nothing.
    const api = recordingApi();
    captureStdout();
    captureStderr();

    await expect(
      build(api as unknown as ApiClient).parseAsync([
        'node', 'cli', 'ride-elife', 'update', ...BASE,
        '--order-id', 'rio_1', '--idempotency-key', 'i1', '--member', MEMBER,
      ]),
    ).rejects.toThrow(/Nothing to update/);

    expect(api.post).not.toHaveBeenCalled();
  });
});

// ── GET verbs: member_id rides in the query string ─────────────────────────

const GET_CASES: Case[] = [
  {
    name: 'hotel-redaug get',
    args: ['node', 'cli', 'hotel-redaug', 'get', ...BASE, '--order-id', 'hho_1'],
    build: prog('hotel-redaug', registerHotelGetCommand as never),
  },
  {
    name: 'flight-flink get-order',
    args: ['node', 'cli', 'flight-flink', 'get-order', ...BASE, '--order-no', 'ffo_1'],
    build: prog('flight-flink', registerFlightGetOrder as never),
  },
  {
    name: 'ride-elife get',
    args: ['node', 'cli', 'ride-elife', 'get', ...BASE, '--order-id', 'rio_1'],
    build: prog('ride-elife', registerRideGetCommand as never),
  },
  {
    name: 'ride-elife trip-status',
    args: ['node', 'cli', 'ride-elife', 'trip-status', ...BASE, '--order-id', 'rio_1'],
    build: prog('ride-elife', registerRideTripStatusCommand as never),
  },
  {
    name: 'orders get',
    args: ['node', 'cli', 'orders', 'get', ...BASE, '--order-id', 'rio_1'],
    build: prog('orders', registerOrdersGetCommand as never),
  },
];

describe('member on single-order addressing — GET verbs', () => {
  for (const c of GET_CASES) {
    it(`${c.name}: --member is forwarded as query member_id`, async () => {
      const api = recordingApi();
      captureStdout();
      captureStderr();
      await c.build(api as unknown as ApiClient).parseAsync([...c.args, '--member', MEMBER]);

      const params = api.get.mock.calls[0][2] as Record<string, string>;
      expect(params.member_id).toBe(MEMBER);
    });

    it(`${c.name}: omitted --member leaves member_id out of the query`, async () => {
      const api = recordingApi();
      captureStdout();
      captureStderr();
      await c.build(api as unknown as ApiClient).parseAsync(c.args);

      const params = (api.get.mock.calls[0][2] ?? {}) as Record<string, string>;
      expect('member_id' in params).toBe(false);
    });
  }
});

// ── Schemas: the flag must be discoverable AND hidden from the model ───────

describe('member on single-order addressing — verb schemas', () => {
  const schemas = {
    'hotel-redaug pay-order': hotelPayOrderSchema,
    'hotel-redaug cancel': hotelCancelSchema,
    'hotel-redaug checkout': hotelCheckoutSchema,
    'hotel-redaug get': hotelGetSchema,
    'flight-flink pay-order': flightPayOrderSchema,
    'flight-flink cancel-order': flightCancelOrderSchema,
    'flight-flink change-apply': flightChangeApplySchema,
    'flight-flink change-pay': flightChangePaySchema,
    'flight-flink refund-apply': flightRefundApplySchema,
    'flight-flink get-order': flightGetOrderSchema,
    'ride-elife cancel': cancelSchema,
    'ride-elife get': rideGetSchema,
    'ride-elife trip-status': rideTripStatusSchema,
    'ride-elife update': rideUpdateSchema,
    'orders get': unifiedOrdersGetSchema,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}: declares an optional member flag sourced from the session`, () => {
      const flag = schema.flags.member;
      expect(flag, `${name} must declare a member flag`).toBeDefined();
      expect(flag.required).toBe(false);
      // source: 'session' is what keeps the flag out of LLM tool schemas —
      // an agent must not get to choose whose order it pays or cancels.
      expect(flag.source).toBe('session');
    });
  }
});

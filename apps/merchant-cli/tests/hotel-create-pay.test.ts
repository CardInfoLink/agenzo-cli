/**
 * Tests for hotel-redaug create-order and pay-order CLI verbs.
 *
 * Current architecture: create-order is a single write step that BOTH locks
 * the room AND settles payment inline (billing path decided server-side by
 * billing_mode) — it returns the order already PAID. pay-order is retained
 * only as a thin backward-compat replay endpoint (no body params, no
 * merchant-transaction-id, moves no money) for callers still on the old
 * two-step flow.
 *
 * Covers:
 *   - create-order success → exit 0 + order_id, order already PAID (Req 9.1)
 *   - create-order optional --payment-method-id (pay_per_call card selection)
 *   - pay-order compat replay → returns the existing PAID result (Req 9.2, 9.4)
 *   - pay-order on a non-PAID terminal order → INVALID_ORDER_STATE (exit 1)
 *   - --watch mode: returns on first successful poll since there is no
 *     transient "not yet paid" state to retry through anymore (Req 9.5)
 *
 * **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerHotelCreateOrderCommand } from '../src/hotel-redaug/create-order.js';
import { registerHotelPayOrderCommand } from '../src/hotel-redaug/pay-order.js';
import { buildProgram, captureStdout, captureStderr, parseJsonOutput, mockApiClient } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// Response fixtures
// ============================================================

const CREATE_ORDER_RESP = {
  order_id: 'ord_new1',
  fc_order_code: 'fc_new1',
  order_status: 'PAID',
  total_amount: 640,
  currency: 'CNY',
  rooms: [{ room_index: '1', guest_name: 'Alice' }],
};

const PAY_ORDER_REPLAY_MONTHLY_RESP = {
  order_id: 'ord_new1',
  settlement_path: 'monthly_settlement',
  status: 'PAID',
  amount: 640,
  currency: 'CNY',
};

const PAY_ORDER_REPLAY_PER_CALL_RESP = {
  order_id: 'ord_new1',
  settlement_path: 'pay_per_call',
  status: 'PAID',
  amount: 640,
  currency: 'CNY',
};

// ============================================================
// Program builder
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function hotelProgram(apiClient: Mock) {
  const program = buildProgram();
  const hotel = program.command('hotel-redaug');
  const deps = { apiClient: apiClient as unknown as ApiClient };
  registerHotelCreateOrderCommand(hotel, deps);
  registerHotelPayOrderCommand(hotel, deps);
  return program;
}

const BASE = ['node', 'cli', 'hotel-redaug'];

// ============================================================
// create-order
// ============================================================

describe('hotel-redaug create-order', () => {
  const createOrderArgs = (extra: string[] = []) => [
    ...BASE, 'create-order', '--api-key', 'k',
    '--product-token', 'tok_1', '--total-amount', '640', '--currency', 'CNY',
    '--price-items', '[{"sale_date":"2026-03-01","sale_price":320,"breakfast_num":2}]',
    '--check-in', '2026-03-01', '--check-out', '2026-03-03',
    '--guest-name', 'Alice', '--contact-name', 'Alice', '--contact-phone', '13800138000',
    ...extra,
  ];

  it('success → exit 0, POSTs /hotel/create-order, order already PAID in stdout (Req 9.1)', async () => {
    const api = mockApiClient({ '/hotel/create-order': CREATE_ORDER_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(createOrderArgs(['--yes', '--idempotency-key', 'co-1', '--format', 'json']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/hotel/create-order');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.product_token).toBe('tok_1');
    expect(body.total_amount).toBe(640);
    expect(body.currency).toBe('CNY');
    expect(body.adults).toBe(2);
    expect(body.children).toBe(0);
    expect(body.nationality).toBe('CN');
    expect(body.contact_country_code).toBe('86');
    // payment-method-id omitted by default (monthly_settlement / auto-selected card)
    expect(body).not.toHaveProperty('payment_method_id');
    expect(headers).toEqual({ 'Idempotency-Key': 'co-1' });
    // Idempotency key is never in the body
    expect(body).not.toHaveProperty('idempotency_key');

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
    expect(payload.order_status).toBe('PAID');
    expect(payload.total_amount).toBe(640);
    expect(payload.currency).toBe('CNY');
  });

  it('--payment-method-id is forwarded when supplied (pay_per_call specific card) (Req 9.3)', async () => {
    const api = mockApiClient({ '/hotel/create-order': CREATE_ORDER_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(
      createOrderArgs(['--yes', '--idempotency-key', 'co-pm-1', '--format', 'json', '--payment-method-id', 'pm_01ABCXYZ']),
    );

    const [, , body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(body.payment_method_id).toBe('pm_01ABCXYZ');
  });

  it('missing required flags → PARAM_INVALID before any request', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'create-order', '--api-key', 'k', '--yes', '--idempotency-key', 'k1']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('no --payment-order-id flag exists (removed per design)', async () => {
    // Verify that create-order does NOT have a --payment-order-id option
    const api = mockApiClient({ '/hotel/create-order': CREATE_ORDER_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    // Should succeed even without --payment-order-id being defined
    await program.parseAsync(createOrderArgs(['--yes', '--idempotency-key', 'co-2', '--format', 'json']));
    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
  });
});

// ============================================================
// pay-order — thin compat replay (monthly_settlement echoed)
// ============================================================

describe('hotel-redaug pay-order (compat replay, monthly_settlement)', () => {
  it('success → exit 0, POSTs /hotel/{order_id}/pay, replays the existing PAID result (Req 9.2, 9.4)', async () => {
    const api = mockApiClient({ '/hotel/ord_new1/pay': PAY_ORDER_REPLAY_MONTHLY_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'pay-order', '--api-key', 'k',
      '--order-id', 'ord_new1',
      '--idempotency-key', 'pay-1',
      '--yes', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/hotel/ord_new1/pay');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    // pay-order sends no body params at all — it moves no money.
    expect(body).toEqual({});
    expect(headers).toEqual({ 'Idempotency-Key': 'pay-1' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
    expect(payload.status).toBe('PAID');
    expect(payload.settlement_path).toBe('monthly_settlement');
  });

  it('missing --order-id → PARAM_INVALID before any request', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'pay-order', '--api-key', 'k',
        '--idempotency-key', 'pay-1', '--yes',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// pay-order — thin compat replay (pay_per_call echoed, same request shape)
// ============================================================

describe('hotel-redaug pay-order (compat replay, pay_per_call)', () => {
  it('order with pay_per_call billing_mode → settlement_path echoed in replay, no extra flags sent (Req 9.3)', async () => {
    const api = mockApiClient({ '/hotel/ord_new1/pay': PAY_ORDER_REPLAY_PER_CALL_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'pay-order', '--api-key', 'k',
      '--order-id', 'ord_new1',
      '--idempotency-key', 'pay-2',
      '--yes', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/hotel/ord_new1/pay');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    // pay-order sends no body params — same request shape regardless of billing_mode.
    expect(body).toEqual({});
    expect(headers).toEqual({ 'Idempotency-Key': 'pay-2' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
    expect(payload.status).toBe('PAID');
    expect(payload.settlement_path).toBe('pay_per_call');
  });
});

// ============================================================
// pay-order — non-PAID terminal order → INVALID_ORDER_STATE
// ============================================================

describe('hotel-redaug pay-order (non-PAID terminal order)', () => {
  it('order in a terminal state other than PAID (e.g. CANCELLED) → exit 1 (Req 9.6)', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 1930,
      errorMessage: 'Invalid order state',
      statusCode: 409,
      code: 'INVALID_ORDER_STATE',
    });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'pay-order', '--api-key', 'k',
        '--order-id', 'ord_new1',
        '--idempotency-key', 'pay-3',
        '--yes', '--format', 'json',
      ]),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// pay-order — --watch mode (retained for back-compat; returns on first poll
// since there is no transient "not yet paid" state anymore)
// ============================================================

describe('hotel-redaug pay-order --watch mode', () => {
  it('returns immediately on first successful poll — order is already PAID (Req 9.5)', async () => {
    const api = mockApiClient({ '/hotel/ord_new1/pay': PAY_ORDER_REPLAY_PER_CALL_RESP });

    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'pay-order', '--api-key', 'k',
      '--order-id', 'ord_new1',
      '--idempotency-key', 'pay-watch-1',
      '--watch',
      '--watch-interval', '1',
      '--watch-timeout', '60',
      '--yes', '--format', 'json',
    ]);

    // Single poll — no transient pending state to retry through.
    expect(api.post).toHaveBeenCalledTimes(1);

    const lines = out.text().trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const line1 = JSON.parse(lines[0]);
    expect(line1.status).toBe('PAID');
  });

  it('non-retryable error in watch mode → throws CliError (exit 1)', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 1930,
      errorMessage: 'Invalid order state',
      statusCode: 409,
      code: 'INVALID_ORDER_STATE',
    });

    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'pay-order', '--api-key', 'k',
        '--order-id', 'ord_new1',
        '--idempotency-key', 'pay-watch-2',
        '--watch',
        '--watch-interval', '0',
        '--watch-timeout', '10',
        '--yes', '--format', 'json',
      ]),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

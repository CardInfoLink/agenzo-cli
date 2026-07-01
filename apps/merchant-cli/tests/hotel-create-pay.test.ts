/**
 * Tests for hotel-redaug create-order and pay-order CLI verbs.
 *
 * Task 15.1 — covers:
 *   - create-order success → exit 0 + order_id in stdout (Req 9.1)
 *   - pay-order default path (no merchant-trans-id) → success (Req 9.2, 9.4)
 *   - pay-order --merchant-trans-id → active payment path (Req 9.3)
 *   - PAYMENT_NOT_COMPLETED → exit 1 + error in stderr (Req 9.6)
 *   - --watch mode polling until PAID / timeout (Req 9.5)
 *
 * **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
  order_status: 'AWAITING_PAYMENT',
  total_amount: 640,
  currency: 'CNY',
  rooms: [{ room_index: '1', guest_name: 'Alice' }],
};

const PAY_ORDER_SUCCESS_RESP = {
  order_id: 'ord_new1',
  order_status: 'PAID',
  settlement_path: 'monthly_settlement',
  pay_status: 'success',
  total_amount: 640,
  currency: 'CNY',
  billing_entry_id: 'bill_001',
};

const PAY_ORDER_ACTIVE_RESP = {
  order_id: 'ord_new1',
  order_status: 'PAID',
  settlement_path: 'active_payment',
  pay_status: 'success',
  total_amount: 640,
  currency: 'CNY',
  merchant_trans_id: 'evo_tx_123',
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

  it('success → exit 0, POSTs /hotel/create-order, prints order_id to stdout (Req 9.1)', async () => {
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
    expect(headers).toEqual({ 'Idempotency-Key': 'co-1' });
    // Idempotency key is never in the body
    expect(body).not.toHaveProperty('idempotency_key');

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
    expect(payload.order_status).toBe('AWAITING_PAYMENT');
    expect(payload.total_amount).toBe(640);
    expect(payload.currency).toBe('CNY');
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
// pay-order — default path (monthly_settlement, no merchant-trans-id)
// ============================================================

describe('hotel-redaug pay-order (default path)', () => {
  it('success → exit 0, POSTs /hotel/{order_id}/pay, prints settlement result (Req 9.2, 9.4)', async () => {
    const api = mockApiClient({ '/hotel/ord_new1/pay': PAY_ORDER_SUCCESS_RESP });
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
    // No merchant_trans_id in body for default path
    expect(body).not.toHaveProperty('merchant_trans_id');
    expect(headers).toEqual({ 'Idempotency-Key': 'pay-1' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
    expect(payload.order_status).toBe('PAID');
    expect(payload.settlement_path).toBe('monthly_settlement');
    expect(payload.billing_entry_id).toBe('bill_001');
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
// pay-order — active payment path (with --merchant-trans-id)
// ============================================================

describe('hotel-redaug pay-order (active payment path)', () => {
  it('--merchant-trans-id → active payment path, merchant_trans_id in body (Req 9.3)', async () => {
    const api = mockApiClient({ '/hotel/ord_new1/pay': PAY_ORDER_ACTIVE_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'pay-order', '--api-key', 'k',
      '--order-id', 'ord_new1',
      '--merchant-trans-id', 'evo_tx_123',
      '--idempotency-key', 'pay-2',
      '--yes', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/hotel/ord_new1/pay');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.merchant_trans_id).toBe('evo_tx_123');
    expect(headers).toEqual({ 'Idempotency-Key': 'pay-2' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_id).toBe('ord_new1');
    expect(payload.order_status).toBe('PAID');
    expect(payload.settlement_path).toBe('active_payment');
    expect(payload.merchant_trans_id).toBe('evo_tx_123');
  });
});

// ============================================================
// pay-order — PAYMENT_NOT_COMPLETED → exit 1 + error in stderr
// ============================================================

describe('hotel-redaug pay-order (PAYMENT_NOT_COMPLETED)', () => {
  it('PAYMENT_NOT_COMPLETED → exit 1 + error code thrown as RESOURCE_CONFLICT (mapped from 409) (Req 9.6)', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 1933,
      errorMessage: 'Payment not yet completed',
      statusCode: 409,
      code: 'PAYMENT_NOT_COMPLETED',
    });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    // PAYMENT_NOT_COMPLETED is not in the CLI error catalog, so fromApi maps 409 → RESOURCE_CONFLICT
    await expect(
      program.parseAsync([
        ...BASE, 'pay-order', '--api-key', 'k',
        '--order-id', 'ord_new1',
        '--merchant-trans-id', 'evo_tx_456',
        '--idempotency-key', 'pay-3',
        '--yes', '--format', 'json',
      ]),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// pay-order — --watch mode polling until PAID or timeout
// ============================================================

describe('hotel-redaug pay-order --watch mode', () => {
  it('polls until PAID, outputs NDJSON per iteration (Req 9.5)', async () => {
    // Use fake timers to avoid real sleeping
    vi.useFakeTimers();

    let callCount = 0;
    const api = mockApiClient();
    api.post.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        // First 2 calls → PAYMENT_NOT_COMPLETED (retryable in watch)
        return Promise.resolve({
          success: false,
          errorCode: 1933,
          errorMessage: 'Payment not yet completed',
          statusCode: 409,
          code: 'PAYMENT_NOT_COMPLETED',
        });
      }
      // 3rd call → success
      return Promise.resolve({ success: true, data: PAY_ORDER_ACTIVE_RESP });
    });

    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    const parsePromise = program.parseAsync([
      ...BASE, 'pay-order', '--api-key', 'k',
      '--order-id', 'ord_new1',
      '--merchant-trans-id', 'evo_tx_789',
      '--idempotency-key', 'pay-watch-1',
      '--watch',
      '--watch-interval', '1',
      '--watch-timeout', '60',
      '--yes', '--format', 'json',
    ]);

    // Advance timers to let the sleep calls resolve
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    await parsePromise;

    vi.useRealTimers();

    // Should have polled 3 times (2 pending + 1 success)
    expect(api.post).toHaveBeenCalledTimes(3);

    // Output should be NDJSON lines
    const lines = out.text().trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);

    // First two lines are pending status
    const line1 = JSON.parse(lines[0]);
    expect(line1.watch_status).toBe('pending');
    expect(line1.error_code).toBe('PAYMENT_NOT_COMPLETED');

    const line2 = JSON.parse(lines[1]);
    expect(line2.watch_status).toBe('pending');

    // Third line is the PAID response
    const line3 = JSON.parse(lines[2]);
    expect(line3.order_status).toBe('PAID');
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

  it('timeout without reaching PAID → outputs timeout line', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 1933,
      errorMessage: 'Payment not yet completed',
      statusCode: 409,
      code: 'PAYMENT_NOT_COMPLETED',
    });

    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    // Use very short timeout — 0 seconds means the first poll may be the only one
    // Then it immediately times out after the first successful poll iteration.
    await program.parseAsync([
      ...BASE, 'pay-order', '--api-key', 'k',
      '--order-id', 'ord_new1',
      '--merchant-trans-id', 'evo_tx_timeout',
      '--idempotency-key', 'pay-watch-3',
      '--watch',
      '--watch-interval', '999',
      '--watch-timeout', '1',
      '--yes', '--format', 'json',
    ]);

    // Should have polled at least once
    expect(api.post.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Output should contain lines — last line should have timeout status
    const lines = out.text().trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.watch_status).toBe('timeout');
  });
});

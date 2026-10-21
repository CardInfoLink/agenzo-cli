import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerOrdersGetPaymentGroupCommand } from '../src/orders/get-payment-group.js';
import { ordersGetPaymentGroupSchema } from '../src/verb-schema.js';
import { buildProgram, captureStderr, captureStdout, parseJsonOutput } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const GROUP = {
  payment_group_id: 'pg_001',
  status: 'partially_settled',
  currency: 'USD',
  total_amount: 320.5,
  per_order: [
    { order_id: 'hho_1', domain: 'hotel', status: 'confirmed', amount: 200.5 },
    { order_id: 'ffo_1', domain: 'flight', status: 'refunded', amount: 120, refunded_amount: 120 },
  ],
};

function setup(get: ReturnType<typeof vi.fn>) {
  const api = { get, post: vi.fn() };
  const out = captureStdout();
  captureStderr();
  const program = buildProgram();
  registerOrdersGetPaymentGroupCommand(program.command('orders'), { apiClient: api as unknown as ApiClient });
  const run = (...args: string[]) =>
    program.parseAsync(['node', 'cli', 'orders', 'get-payment-group', '--api-key', 'k', ...args]);
  return { api, out, run };
}

describe('orders get-payment-group', () => {
  it('GET /orders/payment-groups/<id> and passes the body through', async () => {
    const { api, out, run } = setup(vi.fn().mockResolvedValue({ success: true, data: GROUP }));
    await run('--payment-group-id', 'pg_001', '--format', 'json');
    expect(api.get).toHaveBeenCalledWith('/orders/payment-groups/pg_001', { type: 'api-key', key: 'k' });
    expect(api.post).not.toHaveBeenCalled();
    const payload = parseJsonOutput(out.text()) as any;
    expect(payload.status).toBe('partially_settled');
    expect(payload.per_order[1].refunded_amount).toBe(120);
  });

  it('table view reuses the pay-batch layout', async () => {
    const { out, run } = setup(vi.fn().mockResolvedValue({ success: true, data: GROUP }));
    await run('--payment-group-id', 'pg_001', '--format', 'table');
    const text = out.text();
    expect(text).toContain('pg_001');
    expect(text).toContain('320.5 USD');
    expect(text).toContain('ffo_1');
  });

  it('url-encodes the id', async () => {
    const { api, run } = setup(vi.fn().mockResolvedValue({ success: true, data: GROUP }));
    await run('--payment-group-id', 'pg/../x', '--format', 'json');
    expect(api.get.mock.calls[0][0]).toBe('/orders/payment-groups/pg%2F..%2Fx');
  });

  it('rejects an empty or over-long id before any request', async () => {
    const { api, run } = setup(vi.fn());
    await expect(run('--payment-group-id', '  ', '--format', 'json')).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    await expect(run('--payment-group-id', 'p'.repeat(65), '--format', 'json')).rejects.toMatchObject({
      code: 'PARAM_INVALID',
    });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('accepts exactly 64 characters', async () => {
    const { api, run } = setup(vi.fn().mockResolvedValue({ success: true, data: GROUP }));
    await run('--payment-group-id', 'p'.repeat(64), '--format', 'json');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('bad API key maps to KEY_INVALID', async () => {
    const { run } = setup(
      vi.fn().mockResolvedValue({ success: false, statusCode: 401, errorCode: 1002, errorMessage: 'Invalid key' }),
    );
    await expect(run('--payment-group-id', 'pg_001', '--format', 'json')).rejects.toMatchObject({ code: 'KEY_INVALID' });
  });

  it("another organization's group surfaces the platform not-found error", async () => {
    const { run } = setup(
      vi.fn().mockResolvedValue({
        success: false,
        statusCode: 404,
        errorCode: 1953,
        code: 'ORDER_NOT_FOUND',
        errorMessage: 'Order not found.',
      }),
    );
    await expect(run('--payment-group-id', 'pg_other', '--format', 'json')).rejects.toThrow();
  });

  it('read-only schema with a required id', () => {
    expect(ordersGetPaymentGroupSchema.verb).toBe('get-payment-group');
    expect(ordersGetPaymentGroupSchema.flags['payment-group-id'].required).toBe(true);
    expect(ordersGetPaymentGroupSchema.flags['idempotency-key']).toBeUndefined();
  });
});

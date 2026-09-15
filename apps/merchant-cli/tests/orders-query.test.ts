import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerOrdersListCommand } from '../src/orders/list.js';
import { unifiedOrdersGetSchema, unifiedOrdersListSchema } from '../src/verb-schema.js';
import { buildProgram, captureStderr, captureStdout, parseJsonOutput } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

function recordingApi(data: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue({ success: true, data }),
    post: vi.fn(),
  };
}

describe('orders list query mapping', () => {
  it('maps multi filters, dates, cursor and member to platform query params', async () => {
    const api = recordingApi({
      orders: [],
      total: 0,
      page: 1,
      page_size: 10,
      next_cursor: null,
      has_more: false,
      applied_filters: {},
    });
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerOrdersListCommand(program.command('orders'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync([
      'node', 'cli', 'orders', 'list', '--api-key', 'k', '--format', 'json',
      '--order-types', 'flight,hotel',
      '--statuses', 'CONFIRMED,CANCELLED',
      '--created-from', '2026-07-01T00:00:00Z',
      '--created-to', '2026-08-01T00:00:00Z',
      '--cursor', 'opaque-cursor',
      '--page-size', '10',
      '--member', 'member_1',
    ]);

    expect(api.get).toHaveBeenCalledWith(
      '/orders',
      { type: 'api-key', key: 'k' },
      {
        order_types: 'flight,hotel',
        statuses: 'CONFIRMED,CANCELLED',
        created_from: '2026-07-01T00:00:00Z',
        created_to: '2026-08-01T00:00:00Z',
        cursor: 'opaque-cursor',
        page: '1',
        page_size: '10',
        member_id: 'member_1',
      },
    );
  });

  it('keeps legacy singular filters and offset pagination', async () => {
    const api = recordingApi({ orders: [], total: 0, page: 2, page_size: 5 });
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerOrdersListCommand(program.command('orders'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync([
      'node', 'cli', 'orders', 'list', '--api-key', 'k', '--format', 'json',
      '--order-type', 'flight', '--status', 'CONFIRMED', '--page', '2', '--page-size', '5',
    ]);

    expect(api.get.mock.calls[0][2]).toEqual({
      order_type: 'flight',
      status: 'CONFIRMED',
      page: '2',
      page_size: '5',
    });
  });

  it.each([
    [['--order-type', 'flight', '--order-types', 'flight,hotel'], 'order-type'],
    [['--status', 'CONFIRMED', '--statuses', 'CONFIRMED,CANCELLED'], 'status'],
    [['--cursor', 'opaque', '--page', '2'], 'cursor'],
  ])('rejects conflicting args %j', async (args, expected) => {
    const api = recordingApi();
    captureStdout();
    captureStderr();
    const program = buildProgram();
    registerOrdersListCommand(program.command('orders'), { apiClient: api as unknown as ApiClient });

    await expect(program.parseAsync([
      'node', 'cli', 'orders', 'list', '--api-key', 'k', '--format', 'json', ...args,
    ])).rejects.toThrow(expected);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('preserves next_cursor, has_more and applied_filters in JSON output', async () => {
    const payload = {
      orders: [],
      total: 23,
      page: 1,
      page_size: 20,
      next_cursor: 'next-1',
      has_more: true,
      applied_filters: { order_types: ['flight'] },
    };
    const api = recordingApi(payload);
    const out = captureStdout();
    captureStderr();
    const program = buildProgram();
    registerOrdersListCommand(program.command('orders'), { apiClient: api as unknown as ApiClient });

    await program.parseAsync([
      'node', 'cli', 'orders', 'list', '--api-key', 'k', '--format', 'json',
    ]);

    expect(parseJsonOutput(out.text())).toMatchObject(payload);
  });
});

describe('orders verb schemas', () => {
  it('declares all current order types and new query flags', () => {
    expect(unifiedOrdersListSchema.description).toContain('flight');
    expect(unifiedOrdersListSchema.flags['order-types']).toBeDefined();
    expect(unifiedOrdersListSchema.flags.statuses).toBeDefined();
    expect(unifiedOrdersListSchema.flags['created-from']).toBeDefined();
    expect(unifiedOrdersListSchema.flags['created-to']).toBeDefined();
    expect(unifiedOrdersListSchema.flags.cursor).toBeDefined();
    expect(unifiedOrdersListSchema.response.next_cursor).toBeDefined();
    expect(unifiedOrdersListSchema.response.has_more).toBeDefined();
    expect(unifiedOrdersListSchema.response.applied_filters).toBeDefined();
  });

  it('documents ride, hotel and flight details', () => {
    expect(unifiedOrdersGetSchema.description).toContain('flight');
    expect(unifiedOrdersGetSchema.flags['order-id'].description).toContain('ffo_');
  });
});

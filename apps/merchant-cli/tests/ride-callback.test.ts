import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerRideCallbackCommands } from '../src/ride-elife/callback.js';
import {
  rideCallbackDefaultGetSchema,
  rideCallbackDeliveriesSchema,
  rideCallbackReplaySchema,
  rideCallbackSetSchema,
} from '../src/verb-schema.js';
import { buildProgram, captureStderr, captureStdout, parseJsonOutput } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const AUTH = { type: 'api-key', key: 'k' };
const SUB = {
  ride_id: '4112961',
  order_id: 'rio_1',
  callback_url: 'https://example.com/ride-events',
  adapter: 'techtanium_v1',
  signature_mode: 'off',
  status: 'active',
};

function setup(resp: { get?: unknown; post?: unknown } = {}) {
  const api = {
    get: vi.fn().mockResolvedValue(resp.get ?? { success: true, data: SUB }),
    post: vi.fn().mockResolvedValue(resp.post ?? { success: true, data: SUB }),
  };
  const out = captureStdout();
  const err = captureStderr();
  const program = buildProgram();
  registerRideCallbackCommands(program.command('ride-elife'), { apiClient: api as unknown as ApiClient });
  const run = (...args: string[]) => program.parseAsync(['node', 'cli', 'ride-elife', ...args, '--api-key', 'k']);
  return { api, out, err, run };
}

describe('ride-elife callback-set', () => {
  it('POSTs only the flags given, key in the header', async () => {
    const { api, run } = setup();
    await run('callback-set', '--order-id', '4112961', '--callback-url', 'https://example.com/ride-events',
      '--idempotency-key', 'cb-1', '--format', 'json');
    expect(api.post).toHaveBeenCalledWith(
      '/ride/4112961/callback',
      AUTH,
      { callback_url: 'https://example.com/ride-events' },
      { 'Idempotency-Key': 'cb-1' },
    );
  });

  it('maps every optional flag', async () => {
    const { api, run } = setup();
    await run('callback-set', '--order-id', '4112961', '--callback-url', 'https://e.com/x', '--adapter', 'custom_v2',
      '--signature-mode', 'required', '--callback-api-key', 'ck_1', '--rotate-secret', '--idempotency-key', 'cb-2',
      '--format', 'json');
    expect(api.post.mock.calls[0][2]).toEqual({
      callback_url: 'https://e.com/x',
      adapter: 'custom_v2',
      signature_mode: 'required',
      callback_api_key: 'ck_1',
      rotate_secret: true,
    });
  });

  it('shows the one-time secret with a warning in table mode', async () => {
    const { out, run } = setup({ post: { success: true, data: { ...SUB, callback_secret: 'sec_once' } } });
    await run('callback-set', '--order-id', '4112961', '--callback-url', 'https://e.com/x', '--idempotency-key', 'cb-3',
      '--format', 'table');
    expect(out.text()).toContain('sec_once');
    expect(out.text()).toContain('shown only once');
  });

  it('rejects missing order-id, missing url and a bad signature mode before any request', async () => {
    const { api, run } = setup();
    await expect(run('callback-set', '--callback-url', 'https://e.com/x', '--idempotency-key', 'a'))
      .rejects.toMatchObject({ code: 'PARAM_INVALID' });
    await expect(run('callback-set', '--order-id', '1', '--idempotency-key', 'a'))
      .rejects.toMatchObject({ code: 'PARAM_INVALID' });
    await expect(run('callback-set', '--order-id', '1', '--callback-url', 'https://e.com/x', '--signature-mode', 'strict',
      '--idempotency-key', 'a')).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('requires --idempotency-key under --yes', async () => {
    const { api } = setup();
    const program = buildProgram();
    registerRideCallbackCommands(program.command('ride-elife'), { apiClient: api as unknown as ApiClient });
    await expect(program.parseAsync(['node', 'cli', '--yes', 'ride-elife', 'callback-set', '--order-id', '1',
      '--callback-url', 'https://e.com/x', '--api-key', 'k'])).rejects.toMatchObject({ code: 'PARAM_IDEMPOTENCY_KEY_REQUIRED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("someone else's ride or an internal URL surfaces the platform error", async () => {
    const { run } = setup({
      post: { success: false, statusCode: 404, errorCode: 4203, code: 'RIDE_NOT_FOUND', errorMessage: 'Ride not found.' },
    });
    await expect(run('callback-set', '--order-id', '999', '--callback-url', 'https://e.com/x', '--idempotency-key', 'a',
      '--format', 'json')).rejects.toThrow();
  });

  it('bad API key maps to KEY_INVALID', async () => {
    const { run } = setup({ post: { success: false, statusCode: 401, errorCode: 1002, errorMessage: 'Invalid key' } });
    await expect(run('callback-set', '--order-id', '1', '--callback-url', 'https://e.com/x', '--idempotency-key', 'a',
      '--format', 'json')).rejects.toMatchObject({ code: 'KEY_INVALID' });
  });
});

describe('ride-elife callback-default-set / -get / callback-get', () => {
  it('default-set posts to /ride/callback/default without an order id', async () => {
    const { api, run } = setup();
    await run('callback-default-set', '--callback-url', 'https://e.com/x', '--idempotency-key', 'd-1', '--format', 'json');
    expect(api.post).toHaveBeenCalledWith('/ride/callback/default', AUTH, { callback_url: 'https://e.com/x' },
      { 'Idempotency-Key': 'd-1' });
  });

  it('default-get and callback-get are plain GETs', async () => {
    const { api, out, run } = setup();
    await run('callback-default-get', '--format', 'json');
    await run('callback-get', '--order-id', '4112961', '--format', 'json');
    expect(api.get.mock.calls[0]).toEqual(['/ride/callback/default', AUTH, undefined]);
    expect(api.get.mock.calls[1]).toEqual(['/ride/4112961/callback', AUTH, undefined]);
    expect(api.post).not.toHaveBeenCalled();
    expect(out.text()).not.toContain('callback_secret');
  });

  it('callback-get needs an order id', async () => {
    const { api, run } = setup();
    await expect(run('callback-get', '--format', 'json')).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('ride-elife callback-deliveries', () => {
  const PAGE = {
    ride_id: '4112961', limit: 2, offset: 0, count: 1,
    deliveries: [{ event_id: 'ev_1', status: 'dead', attempts: 8, last_error: 'HTTP 500' }],
  };

  it('passes limit/offset as query params and lists records', async () => {
    const { api, out, run } = setup({ get: { success: true, data: PAGE } });
    await run('callback-deliveries', '--order-id', '4112961', '--limit', '2', '--offset', '0', '--format', 'table');
    expect(api.get).toHaveBeenCalledWith('/ride/4112961/callback/deliveries', AUTH, { limit: '2', offset: '0' });
    expect(out.text()).toContain('ev_1');
    expect(out.text()).toContain('dead');
  });

  it('omits paging when not given', async () => {
    const { api, run } = setup({ get: { success: true, data: { ...PAGE, deliveries: [] } } });
    await run('callback-deliveries', '--order-id', '4112961', '--format', 'json');
    expect(api.get.mock.calls[0][2]).toBeUndefined();
  });

  it.each([['--limit', '0'], ['--limit', '101'], ['--limit', '1.5'], ['--offset', '-1']])(
    'rejects %s %s before any request',
    async (flag, value) => {
      const { api, run } = setup();
      await expect(run('callback-deliveries', '--order-id', '1', flag, value, '--format', 'json'))
        .rejects.toMatchObject({ code: 'PARAM_INVALID' });
      expect(api.get).not.toHaveBeenCalled();
    },
  );

  it('accepts the limit bounds 1 and 100', async () => {
    const { api, run } = setup({ get: { success: true, data: PAGE } });
    await run('callback-deliveries', '--order-id', '1', '--limit', '1', '--format', 'json');
    await run('callback-deliveries', '--order-id', '1', '--limit', '100', '--format', 'json');
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

describe('ride-elife callback-replay', () => {
  it('sends an empty body by default (requeue all dead records)', async () => {
    const { api, out, run } = setup({ post: { success: true, data: { ride_id: '4112961', requeued: 3 } } });
    await run('callback-replay', '--order-id', '4112961', '--idempotency-key', 'rp-1', '--format', 'json');
    expect(api.post).toHaveBeenCalledWith('/ride/4112961/callback/replay', AUTH, {}, { 'Idempotency-Key': 'rp-1' });
    expect((parseJsonOutput(out.text()) as any).requeued).toBe(3);
  });

  it('maps event-id / include-failed / reset-attempts', async () => {
    const { api, run } = setup({ post: { success: true, data: { ride_id: '1', requeued: 1 } } });
    await run('callback-replay', '--order-id', '1', '--event-id', 'ev_1', '--include-failed', '--reset-attempts',
      '--idempotency-key', 'rp-2', '--format', 'json');
    expect(api.post.mock.calls[0][2]).toEqual({ event_id: 'ev_1', include_failed: true, reset_attempts: true });
  });

  it('rejects a malformed idempotency key before any request', async () => {
    const { api, run } = setup();
    await expect(run('callback-replay', '--order-id', '1', '--idempotency-key', 'bad key!', '--format', 'json'))
      .rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('ride callback schemas', () => {
  it('writes require an idempotency key, reads do not declare one', () => {
    expect(rideCallbackSetSchema.flags['idempotency-key'].required).toBe(true);
    expect(rideCallbackReplaySchema.flags['idempotency-key'].required).toBe(true);
    expect(rideCallbackDeliveriesSchema.flags['idempotency-key']).toBeUndefined();
    expect(rideCallbackDefaultGetSchema.flags['idempotency-key']).toBeUndefined();
  });
});

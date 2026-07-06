import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerPayCommand } from '../src/charge/pay.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from '../../token-cli/tests/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const CHARGE_RESULT = {
  charge_no: 'chg_abc123',
  payment_brand: 'evo',
  amount_cents: 1200,
  fee_cents: 0,
  total_cents: 1200,
  currency: 'USD',
  pay_status: 'success',
  merchant_trans_id: 'M001',
  evo_trans_id: 'E001',
};

describe('capture', () => {
  it('happy path: POST /pay with payment_token_id, no payment_brand in body (auto-detected server-side)', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/pay',
      { type: 'api-key', key: 'sk_key' },
      { payment_token_id: 'ptk_abc' },
      { 'Idempotency-Key': 'idem_1' },
    );

    const output = out.text();
    expect(output).toContain('chg_abc123');
    expect(output).toContain('success');
  });

  it('request body does not include amount or currency (taken from the token)', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_2',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('currency');
  });

  it('--payment-brand override is forwarded when provided', async () => {
    const apiClient = mockApiClient({ '/pay': { ...CHARGE_RESULT, payment_brand: 'unionpay' } });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_upi',
      '--payment-brand', 'unionpay',
      '--idempotency-key', 'idem_3',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body.payment_brand).toBe('unionpay');
  });

  it('rejects an unknown --payment-brand value', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'capture',
        '--api-key', 'sk_key',
        '--payment-token-id', 'ptk_abc',
        '--payment-brand', 'visa',
        '--idempotency-key', 'idem_4',
        '--yes',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('missing --idempotency-key in --yes mode throws IdempotencyKeyRequiredError', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'capture',
        '--api-key', 'sk_key',
        '--payment-token-id', 'ptk_abc',
        '--yes',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('--format json emits parseable JSON', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_5',
      '--yes',
      '--format', 'json',
    ]);

    const parsed = JSON.parse(out.text().trim()) as Record<string, unknown>;
    expect(parsed.charge_no).toBe('chg_abc123');
    expect(parsed.pay_status).toBe('success');
  });

  it('optional --description is forwarded when provided', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_6',
      '--description', 'ride fare',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body.description).toBe('ride fare');
  });
});

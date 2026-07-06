import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerPayCommand } from '../src/charge/pay.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from '../../token-cli/tests/helpers.js';

// pay verb never prompts for card details, so no @inquirer mocks needed for
// the happy path — only the idempotency-key prompt path is exercised via
// explicit flags to keep tests non-interactive.

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

describe('charge pay', () => {
  it('happy path: POST /pay with payment_token_id + payment_brand, headers carry api key + idempotency key', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge', 'pay',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/pay',
      { type: 'api-key', key: 'sk_key' },
      { payment_token_id: 'ptk_abc', payment_brand: 'evo' },
      { 'Idempotency-Key': 'idem_1' },
    );

    const output = out.text();
    expect(output).toContain('chg_abc123');
    expect(output).toContain('success');
  });

  it('request body does not include amount or currency (taken from the token)', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge', 'pay',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_2',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('currency');
  });

  it('--payment-brand unionpay is forwarded verbatim', async () => {
    const apiClient = mockApiClient({ '/pay': { ...CHARGE_RESULT, payment_brand: 'unionpay' } });
    const program = buildProgram();
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge', 'pay',
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
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'charge', 'pay',
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
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'charge', 'pay',
        '--api-key', 'sk_key',
        '--payment-token-id', 'ptk_abc',
        '--yes',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('--format json emits parseable JSON without amount field leakage', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge', 'pay',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_5',
      '--yes',
      '--format', 'json',
    ]);

    // renderWithContext pretty-prints the JSON envelope as a single multi-line
    // object (profile/endpoint spread + payload), not NDJSON — parse it whole.
    const parsed = JSON.parse(out.text().trim()) as Record<string, unknown>;
    expect(parsed.charge_no).toBe('chg_abc123');
    expect(parsed.pay_status).toBe('success');
    expect(parsed).not.toHaveProperty('amount');
    expect(parsed).not.toHaveProperty('currency_input');
  });

  it('optional --description is forwarded when provided', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    const cmd = program.command('charge');
    registerPayCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge', 'pay',
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

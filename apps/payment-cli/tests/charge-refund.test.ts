import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerChargeCardCommand } from '../src/payments/charge-card.js';
import { registerChargeCardResumeCommand } from '../src/payments/charge-card-resume.js';
import { registerRefundCommand } from '../src/payments/refund.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from '../../token-cli/tests/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const CARD_CHARGE_REQUIRES_ACTION = {
  charge_no: 'chg_evo1',
  status: 'requires_action',
  amount_cents: 4433,
  currency: 'USD',
  payment_brand: 'evo',
  three_ds_url: 'https://3ds.example/challenge',
  merchant_trans_id: 'sc_1',
};

const CARD_CHARGE_SUCCESS = {
  charge_no: 'chg_evo1',
  status: 'success',
  amount_cents: 4433,
  currency: 'USD',
  payment_brand: 'evo',
  merchant_trans_id: 'sc_1',
  evo_trans_id: 'E2',
};

const REFUND_RESULT = {
  refund_no: 'rfd_1',
  charge_no: 'chg_evo1',
  refunded_cents: 4433,
  currency: 'USD',
  status: 'success',
  merchant_trans_id: 'sc_1',
  evo_trans_id: 'E3',
};

describe('payments charge-card', () => {
  it('happy path: POST /charge/card with card + amount + phone; returns 3DS challenge', async () => {
    const apiClient = mockApiClient({ '/charge/card': CARD_CHARGE_REQUIRES_ACTION });
    const program = buildProgram();
    registerChargeCardCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge-card',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_1',
      '--amount-cents', '4433',
      '--cardholder-phone', '+14155551234',
      '--member-id', 'mem_1',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/charge/card',
      { type: 'api-key', key: 'sk_key' },
      {
        payment_method_id: 'pm_1',
        amount_cents: 4433,
        currency: 'USD',
        cardholder_phone: '+14155551234',
        member_id: 'mem_1',
      },
      { 'Idempotency-Key': 'idem_1' },
    );
    expect(out.text()).toContain('chg_evo1');
    expect(out.text()).toContain('requires_action');
  });

  it('rejects a non-integer / non-positive --amount-cents', async () => {
    const apiClient = mockApiClient({ '/charge/card': CARD_CHARGE_REQUIRES_ACTION });
    const program = buildProgram();
    registerChargeCardCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'charge-card',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_1',
        '--amount-cents', '12.5',
        '--cardholder-phone', '+14155551234',
        '--idempotency-key', 'idem_1',
        '--yes',
      ]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('missing --idempotency-key in --yes mode throws', async () => {
    const apiClient = mockApiClient({ '/charge/card': CARD_CHARGE_REQUIRES_ACTION });
    const program = buildProgram();
    registerChargeCardCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'charge-card',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_1',
        '--amount-cents', '4433',
        '--cardholder-phone', '+14155551234',
        '--yes',
      ]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('missing --cardholder-phone in --yes mode throws (EVO 3DS requires it)', async () => {
    const apiClient = mockApiClient({ '/charge/card': CARD_CHARGE_REQUIRES_ACTION });
    const program = buildProgram();
    registerChargeCardCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'charge-card',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_1',
        '--amount-cents', '4433',
        '--idempotency-key', 'idem_1',
        '--yes',
      ]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('payments charge-card-resume', () => {
  it('happy path: POST /charge/card/resume with charge_no, no Idempotency-Key header', async () => {
    const apiClient = mockApiClient({ '/charge/card/resume': CARD_CHARGE_SUCCESS });
    const program = buildProgram();
    registerChargeCardResumeCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'charge-card-resume',
      '--api-key', 'sk_key',
      '--charge-no', 'chg_evo1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/charge/card/resume',
      { type: 'api-key', key: 'sk_key' },
      { charge_no: 'chg_evo1' },
    );
    expect(out.text()).toContain('success');
  });

  it('missing --charge-no in --yes mode throws', async () => {
    const apiClient = mockApiClient({ '/charge/card/resume': CARD_CHARGE_SUCCESS });
    const program = buildProgram();
    registerChargeCardResumeCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'charge-card-resume', '--api-key', 'sk_key', '--yes']),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('payments refund', () => {
  it('happy path: full refund by charge_no (no amount in body)', async () => {
    const apiClient = mockApiClient({ '/refund': REFUND_RESULT });
    const program = buildProgram();
    registerRefundCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'refund',
      '--api-key', 'sk_key',
      '--charge-no', 'chg_evo1',
      '--idempotency-key', 'idem_r1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/refund',
      { type: 'api-key', key: 'sk_key' },
      { charge_no: 'chg_evo1' },
      { 'Idempotency-Key': 'idem_r1' },
    );
    const body = apiClient.post.mock.calls[0][2];
    expect(body).not.toHaveProperty('amount_cents');
    expect(out.text()).toContain('rfd_1');
  });

  it('partial refund forwards amount_cents', async () => {
    const apiClient = mockApiClient({ '/refund': { ...REFUND_RESULT, refunded_cents: 1000 } });
    const program = buildProgram();
    registerRefundCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'refund',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_1',
      '--amount-cents', '1000',
      '--idempotency-key', 'idem_r2',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body.payment_token_id).toBe('ptk_1');
    expect(body.amount_cents).toBe(1000);
  });

  it('missing locator (no charge_no / payment_token_id) in --yes mode throws', async () => {
    const apiClient = mockApiClient({ '/refund': REFUND_RESULT });
    const program = buildProgram();
    registerRefundCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'refund',
        '--api-key', 'sk_key',
        '--idempotency-key', 'idem_r3',
        '--yes',
      ]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('missing --idempotency-key in --yes mode throws', async () => {
    const apiClient = mockApiClient({ '/refund': REFUND_RESULT });
    const program = buildProgram();
    registerRefundCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'refund',
        '--api-key', 'sk_key',
        '--charge-no', 'chg_evo1',
        '--yes',
      ]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

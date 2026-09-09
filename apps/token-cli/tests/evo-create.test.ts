import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerEvoCreateCommand } from '../src/payment-tokens/evo-create.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// evo-create runs entirely in --yes mode in these tests (all required flags
// supplied), so no interactive prompt should ever fire. Mock @inquirer/prompts
// defensively so a missed branch surfaces as a bad value rather than a hang.
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('pm_auto'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

/**
 * An ACTIVE EVO network-token response — the expected happy-path shape. EVO
 * minting is synchronous ACTIVE with cryptogram and **NO URL** (cardholder auth
 * happened at Drop-in binding), so the fixture deliberately carries neither a
 * payment_url nor a checkout_url.
 */
const EVO_ACTIVE = {
  id: 'ptk_evo_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'evo',
};

// ============================================================
// payment-tokens evo-create — request body shape (R7.1, R7.2, R13.3)
// ============================================================
//
// Complements the round-trip parametrization in evo-create.property.test.ts
// (task 4.5): this asserts the FULL body composition once — the top-level
// integer `amount`, the verbatim Idempotency-Key header, and the deliberate
// ABSENCE of a nested `visa` object, of any recipient_* field, and of any URL
// (EVO minting is a single synchronous call with no browser handshake).

describe('payment-tokens evo-create — request body', () => {
  it('POSTs exactly one network_token body with top-level integer amount + currency, no visa/recipient/url', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_evo_1',
      '--amount-cents', '12345',
      '--currency', 'USD',
      '--idempotency-key', 'idem_evo',
    ]);

    // Exactly one minting request, to the shared create endpoint, with the
    // api-key auth, the assembled body, and the verbatim Idempotency-Key header.
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/create',
      { type: 'api-key', key: 'sk_key' },
      expect.objectContaining({
        type: 'network_token',
        payment_method_id: 'pm_evo_1',
        amount: 12345,
        currency: 'USD',
      }),
      { 'Idempotency-Key': 'idem_evo' },
    );

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    // amount is a TOP-LEVEL integer-cents field (EVO's placement), NOT nested
    // under visa and NOT the UnionPay decimal-string field.
    expect(typeof body.amount).toBe('number');
    expect(Number.isInteger(body.amount)).toBe(true);
    expect(body.amount).toBe(12345);
    expect(body).not.toHaveProperty('visa'); // no nested Visa DTO on the EVO rail
    expect(body).not.toHaveProperty('order_amount_cents'); // that's Visa's nested field
    expect(body).not.toHaveProperty('unionpay_amount'); // not the UnionPay decimal-string field

    // No recipient_* fields (those belong to UnionPay minting only).
    expect(body).not.toHaveProperty('recipient_name');
    expect(body).not.toHaveProperty('recipient_account');
    expect(body).not.toHaveProperty('recipient_first_name');
    expect(body).not.toHaveProperty('recipient_last_name');
    expect(body).not.toHaveProperty('recipient_email');
    expect(body).not.toHaveProperty('recipient_phone');

    // No URL of any kind is sent — EVO minting has no browser handshake.
    expect(body).not.toHaveProperty('return_url');
    expect(body).not.toHaveProperty('payment_url');
    expect(body).not.toHaveProperty('checkout_url');
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('omits currency when not provided, sending only type/payment_method_id/amount', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_evo_1',
      '--amount-cents', '500',
      '--idempotency-key', 'idem_evo2',
    ]);

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('currency');
    expect(body).toEqual({
      type: 'network_token',
      payment_method_id: 'pm_evo_1',
      amount: 500,
    });
  });
});

// ============================================================
// payment-tokens evo-create — integer-cents validation (R7.3, R13.6)
// ============================================================
//
// The EVO range is [1, 999,999,999,999] (12 digits, R13.6) — WIDER than
// visa-create's [1, 99,999,999]. A decimal, a non-positive value, or an
// out-of-range value is rejected up-front (PARAM_INVALID, non-zero exit) with
// NO request sent.

describe('payment-tokens evo-create — amount-cents validation', () => {
  it('rejects a decimal amount up-front without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', '12.50',
        '--idempotency-key', 'idem_dec',
      ]),
    ).rejects.toThrow(/amount-cents/);

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount (0) without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', '0',
        '--idempotency-key', 'idem_zero',
      ]),
    ).rejects.toThrow(/amount-cents/);

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range amount (> 999,999,999,999) without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', '1000000000000', // 10^12, one past the 999,999,999,999 max
        '--idempotency-key', 'idem_over',
      ]),
    ).rejects.toThrow(/amount-cents/);

    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-tokens evo-create — idempotency-key guard (R7.5)
// ============================================================

describe('payment-tokens evo-create — idempotency-key', () => {
  it('fails fast in --yes mode when --idempotency-key is missing, without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', '12345',
      ]),
    ).rejects.toThrow('--idempotency-key');

    // No auto-generated key, no request.
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-tokens evo-create — clean JSON output (R7.4)
// ============================================================

describe('payment-tokens evo-create — --format json', () => {
  it('emits a single JSON-parseable object with id + status and NO url, no log noise on stdout', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--format', 'json', '--yes', 'payment-tokens', 'evo-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_evo_1',
      '--amount-cents', '12345',
      '--idempotency-key', 'idem_json',
    ]);

    // The entire stdout must parse as ONE JSON object (no progress/log lines mixed in).
    const json = JSON.parse(out.text().trim()) as Record<string, unknown>;
    expect(json.id).toBe('ptk_evo_001');
    expect(json.status).toBe('ACTIVE');
    // EVO minting returns NO URL — no token URL field must surface in the
    // output. (The object also carries render-context metadata such as the
    // profile endpoint, so we assert the ABSENCE of the token URL fields
    // specifically rather than scanning for the substring "http".)
    expect(json).not.toHaveProperty('payment_url');
    expect(json).not.toHaveProperty('checkout_url');
  });
});

// ============================================================
// payment-tokens evo-create — failure guards (R7.6)
// ============================================================

describe('payment-tokens evo-create — failure guards', () => {
  it('platform error response → throws (non-zero exit) and prints nothing', async () => {
    const apiClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 500,
        errorCode: 5000,
        errorMessage: 'EVO network-token upstream failure',
      }),
    };
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', '12345',
        '--idempotency-key', 'idem_err',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    // Nothing reaches stdout on the failure path.
    expect(out.text()).toBe('');
  });

  it('status != ACTIVE → throws (non-zero exit) and never renders the non-ACTIVE token', async () => {
    // A PENDING token: EVO minting is SYNCHRONOUS ACTIVE, so a non-ACTIVE
    // status means minting did not succeed. The guard must fire BEFORE any
    // render, so nothing about the token reaches stdout.
    const apiClient = mockApiClient({
      '/payment-tokens/create': {
        id: 'ptk_evo_bad',
        type: 'network_token',
        status: 'PENDING',
        payment_brand: 'evo',
      },
    });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', '12345',
        '--idempotency-key', 'idem_state',
      ]),
    ).rejects.toThrow(/ACTIVE/);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(out.text()).not.toContain('ptk_evo_bad');
  });
});

// ============================================================
// payment-tokens evo-create — programmatic-only (R7.7)
// ============================================================

describe('payment-tokens evo-create — no attachSchemaHelp', () => {
  it('does not register the --help --format json verb schema (mirrors visa-create / unionpay-create / dropin-create)', () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    const evoCmd = cmd.commands.find((c) => c.name() === 'evo-create');
    expect(evoCmd).toBeTruthy();

    // If attachSchemaHelp were wired, helpInformation() would call emitSchema
    // (console.log) and return '' when --format json is on argv. Its absence
    // means commander's default text help renders instead — no JSON schema.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = ['node', 'cli', 'payment-tokens', 'evo-create', '--help', '--format', 'json'];
    try {
      const help = evoCmd!.helpInformation();
      expect(help).not.toBe('');
      expect(help).toContain('--amount-cents');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerVisaCreateCommand } from '../src/payment-tokens/visa-create.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// visa-create runs entirely in --yes mode in these tests (all required flags
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

/** A PENDING Visa network-token response — the expected happy-path shape. */
const VISA_PENDING = {
  id: 'ptk_visa_001',
  type: 'network_token',
  status: 'PENDING',
  payment_brand: 'visa',
  payment_url: 'https://checkout.visa.example/passkey/abc123',
  payment_url_expires_in: 600,
};

// ============================================================
// payment-tokens visa-create — request body shape (R6.1, R6.2, R13.1)
// ============================================================

describe('payment-tokens visa-create — request body', () => {
  it('POSTs exactly one network_token body with nested visa.order_amount_cents and top-level currency', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_visa_1',
      '--order-amount-cents', '12345',
      '--currency', 'USD',
      '--order-description', 'Test order',
      '--merchant-order-id', 'mo_1',
      '--idempotency-key', 'idem_visa',
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
        payment_method_id: 'pm_visa_1',
        currency: 'USD',
        visa: expect.objectContaining({
          order_amount_cents: 12345,
          order_description: 'Test order',
          merchant_order_id: 'mo_1',
        }),
      }),
      { 'Idempotency-Key': 'idem_visa' },
    );

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    // currency is a TOP-LEVEL field; order_amount_cents lives NESTED under visa.
    expect(body).toHaveProperty('currency', 'USD');
    expect(body).not.toHaveProperty('order_amount_cents');
    expect(body).not.toHaveProperty('amount'); // Visa rail never sends a top-level amount
    // Integer cents, passed through byte-for-byte (no unit conversion).
    expect(typeof body.visa.order_amount_cents).toBe('number');
    expect(body.visa.order_amount_cents).toBe(12345);
  });

  it('omits currency and the optional visa fields when not provided', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_visa_1',
      '--order-amount-cents', '500',
      '--idempotency-key', 'idem_visa2',
    ]);

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('currency');
    expect(body.visa).toEqual({ order_amount_cents: 500 });
  });
});

// ============================================================
// payment-tokens visa-create — integer-cents validation (R6.3)
// ============================================================

describe('payment-tokens visa-create — order-amount-cents validation', () => {
  it('rejects a decimal amount up-front without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_visa_1',
        '--order-amount-cents', '12.50',
        '--idempotency-key', 'idem_dec',
      ]),
    ).rejects.toThrow(/order-amount-cents/);

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount (0) without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_visa_1',
        '--order-amount-cents', '0',
        '--idempotency-key', 'idem_zero',
      ]),
    ).rejects.toThrow(/order-amount-cents/);

    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-tokens visa-create — idempotency-key guard (R6.4)
// ============================================================

describe('payment-tokens visa-create — idempotency-key', () => {
  it('fails fast in --yes mode when --idempotency-key is missing, without sending a request', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_visa_1',
        '--order-amount-cents', '12345',
      ]),
    ).rejects.toThrow('--idempotency-key');

    // No auto-generated key, no request.
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-tokens visa-create — clean JSON output (R6.5)
// ============================================================

describe('payment-tokens visa-create — --format json', () => {
  it('emits a single JSON-parseable object with id / status / payment_url and no log noise on stdout', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--format', 'json', '--yes', 'payment-tokens', 'visa-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_visa_1',
      '--order-amount-cents', '12345',
      '--idempotency-key', 'idem_json',
    ]);

    // The entire stdout must parse as ONE JSON object (no progress/log lines mixed in).
    const json = JSON.parse(out.text().trim()) as Record<string, unknown>;
    expect(json.id).toBe('ptk_visa_001');
    expect(json.status).toBe('PENDING');
    expect(json.payment_url).toBe('https://checkout.visa.example/passkey/abc123');
  });
});

// ============================================================
// payment-tokens visa-create — failure guards (R6.5, R6.6)
// ============================================================

describe('payment-tokens visa-create — failure guards', () => {
  it('platform error response → throws (non-zero exit) and never prints a payment_url', async () => {
    const apiClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 500,
        errorCode: 5000,
        errorMessage: 'Visa VTS upstream failure',
      }),
    };
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_visa_1',
        '--order-amount-cents', '12345',
        '--idempotency-key', 'idem_err',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    // Nothing (least of all a payment_url) reaches stdout on the failure path.
    expect(out.text()).toBe('');
    expect(out.text()).not.toContain('http');
  });

  it('status != PENDING → throws (non-zero exit) and never prints the returned payment_url', async () => {
    // A non-PENDING token that still carries a payment_url: the guard must fire
    // BEFORE any render, so the url is never leaked to stdout.
    const apiClient = mockApiClient({
      '/payment-tokens/create': {
        id: 'ptk_visa_bad',
        type: 'network_token',
        status: 'ACTIVE',
        payment_url: 'https://should-not-print.example/leak',
      },
    });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_visa_1',
        '--order-amount-cents', '12345',
        '--idempotency-key', 'idem_state',
      ]),
    ).rejects.toThrow(/PENDING/);

    expect(out.text()).not.toContain('should-not-print.example');
    expect(out.text()).not.toContain('Payment URL');
  });
});

// ============================================================
// payment-tokens visa-create — programmatic-only (R6.7)
// ============================================================

describe('payment-tokens visa-create — no attachSchemaHelp', () => {
  it('does not register the --help --format json verb schema (mirrors unionpay-create / dropin-create)', () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    const visaCmd = cmd.commands.find((c) => c.name() === 'visa-create');
    expect(visaCmd).toBeTruthy();

    // If attachSchemaHelp were wired, helpInformation() would call emitSchema
    // (console.log) and return '' when --format json is on argv. Its absence
    // means commander's default text help renders instead — no JSON schema.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = ['node', 'cli', 'payment-tokens', 'visa-create', '--help', '--format', 'json'];
    try {
      const help = visaCmd!.helpInformation();
      expect(help).not.toBe('');
      expect(help).toContain('--order-amount-cents');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });
});

// ============================================================
// payment-tokens visa-create — Property 1: amount-unit round-trip (R13.1)
// ============================================================
//
// Property 1 (金额单位往返一致 / amount-unit round-trip, Visa side):
// the integer cents supplied at the entry (`--order-amount-cents`) MUST land in
// the request body as `visa.order_amount_cents` byte-for-byte, with NO unit
// conversion whatsoever. The Visa rail carries integer cents natively and MUST
// NOT route through `cents_to_decimal` (contrast UnionPay's `unionpay_amount`,
// a two-decimal string). These parametrized cases pin the boundary values
// called out by the spec (5→5, 100→100, 12345→12345) and assert the absence of
// any decimal / top-level `amount` representation anywhere in the payload.
// Validates: Requirements 13.1

describe('payment-tokens visa-create — Property 1: amount-unit round-trip (R13.1)', () => {
  // [entry integer cents, the decimal string it would WRONGLY become under
  // cents_to_decimal — must never appear in the Visa payload].
  const ROUND_TRIP_CASES: Array<[cents: number, wrongDecimal: string]> = [
    [5, '0.05'],
    [100, '1.00'],
    [12345, '123.45'],
  ];

  it.each(ROUND_TRIP_CASES)(
    'order_amount_cents == entry cents byte-for-byte with no unit conversion (%i → %i)',
    async (cents, wrongDecimal) => {
      const apiClient = mockApiClient({ '/payment-tokens/create': VISA_PENDING });
      const program = buildProgram();
      const cmd = program.command('payment-tokens');
      registerVisaCreateCommand(cmd, { apiClient } as any);

      captureStdout();
      captureStderr();

      await program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_visa_1',
        '--order-amount-cents', String(cents),
        '--idempotency-key', `idem_rt_${cents}`,
      ]);

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      const body = apiClient.post.mock.calls[0][2] as Record<string, any>;

      // Nested integer cents, identical to the entry value — same number, same
      // type, no scaling. `12345 → 12345`, NOT `123.45`.
      expect(typeof body.visa.order_amount_cents).toBe('number');
      expect(Number.isInteger(body.visa.order_amount_cents)).toBe(true);
      expect(body.visa.order_amount_cents).toBe(cents);
      // Byte-for-byte: the serialized number equals the entry digits verbatim.
      expect(String(body.visa.order_amount_cents)).toBe(String(cents));

      // No decimal conversion / no alternate amount source anywhere.
      expect(body).not.toHaveProperty('amount'); // never a top-level amount
      expect(body).not.toHaveProperty('order_amount_cents'); // stays NESTED under visa
      expect(body).not.toHaveProperty('unionpay_amount'); // not the UnionPay decimal-string field

      // The `cents_to_decimal` output must appear NOWHERE in the payload — the
      // strongest guard that the Visa rail did not scale the amount.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(wrongDecimal);
      expect(serialized).not.toContain('.'); // no decimal point at all in the body
    },
  );
});

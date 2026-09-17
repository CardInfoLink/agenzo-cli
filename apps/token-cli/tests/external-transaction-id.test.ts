import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerUnionpayCreateCommand } from '../src/payment-tokens/unionpay-create.js';
import { registerVisaCreateCommand } from '../src/payment-tokens/visa-create.js';
import { registerEvoCreateCommand } from '../src/payment-tokens/evo-create.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// All three mint commands run entirely in --yes mode here (every required flag
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

// ============================================================
// Task 8.3 — token-cli mint commands forward --external-transaction-id
// into the create_token request body as `external_transaction_id`
// (the order_id to bind this token to), and omit it when not supplied.
//
// This is the CLI half of the strict order↔token binding main path
// (R11.1 / R2 / R4.4): the value maps to the platform create_token request
// body field `external_transaction_id`, distinct from the generic
// `payment-tokens create --external-tx-id` (which maps to `external_tx_id`).
//
// Validates: Requirements 11.1
// ============================================================

/** The merchant order_id the client binds the freshly minted token to. */
const ORDER_ID = 'hho_ord_1';

/** A PENDING UnionPay network-token response (unionpay-create has no status guard). */
const UNIONPAY_PENDING = {
  id: 'ptk_up_001',
  type: 'network_token',
  status: 'PENDING',
  payment_brand: 'unionpay',
  checkout_url: 'https://checkout.unionpay.example/upi/abc123',
  correlation_id: 'corr_1',
};

/** A PENDING Visa network-token response — visa-create requires PENDING. */
const VISA_PENDING = {
  id: 'ptk_visa_001',
  type: 'network_token',
  status: 'PENDING',
  payment_brand: 'visa',
  payment_url: 'https://checkout.visa.example/passkey/abc123',
  payment_url_expires_in: 600,
};

/** ACTIVE terminal shape so visa-create's built-in poll ends on an early tick. */
const VISA_ACTIVE = {
  id: 'ptk_visa_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'visa',
  network_token: { brand: 'Visa', value: '4323126883611456', cryptogram: 'x', expiry_date: '0128' },
};

/** Drive an action that awaits visa-create's poll sleeps, using fake timers. */
async function runWithPoll(action: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    const done = action();
    for (let i = 0; i < 40; i += 1) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    await done;
  } finally {
    vi.useRealTimers();
  }
}

/** An ACTIVE EVO network-token response — evo-create requires ACTIVE. */
const EVO_ACTIVE = {
  id: 'ptk_evo_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'evo',
};

// ------------------------------------------------------------
// unionpay-create
// ------------------------------------------------------------

describe('payment-tokens unionpay-create — --external-transaction-id passthrough (R11.1)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', '--yes', 'payment-tokens', 'unionpay-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_up_1',
    '--unionpay-amount', '174.58',
    '--recipient-first-name', 'Ada',
    '--recipient-last-name', 'Lovelace',
    '--recipient-email', 'ada@example.com',
    ...extra,
  ];

  it('forwards --external-transaction-id into the body as external_transaction_id', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': UNIONPAY_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerUnionpayCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync(
      baseArgs(['--external-transaction-id', ORDER_ID, '--idempotency-key', 'idem_up']),
    );

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.external_transaction_id).toBe(ORDER_ID);
    // The generic create rail's `external_tx_id` is a different field and must
    // NOT be emitted by the dedicated unionpay-create command.
    expect(body).not.toHaveProperty('external_tx_id');
  });

  it('omits external_transaction_id when --external-transaction-id is not supplied', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': UNIONPAY_PENDING });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerUnionpayCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync(baseArgs(['--idempotency-key', 'idem_up_plain']));

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('external_transaction_id');
  });
});

// ------------------------------------------------------------
// visa-create
// ------------------------------------------------------------

describe('payment-tokens visa-create — --external-transaction-id passthrough (R11.1)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_visa_1',
    '--order-amount-cents', '12345',
    ...extra,
  ];

  it('forwards --external-transaction-id at the TOP level as external_transaction_id', async () => {
    const apiClient = mockApiClient({
      '/payment-tokens/create': VISA_PENDING,
      '/payment-tokens/ptk_visa_001': VISA_ACTIVE,
    });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await runWithPoll(() =>
      program.parseAsync(
        baseArgs(['--external-transaction-id', ORDER_ID, '--idempotency-key', 'idem_visa']),
      ),
    );

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    // Sits at the TOP level of the body (the nested `visa.merchant_order_id`
    // is a separate, Visa-specific field and must not absorb the order_id).
    expect(body.external_transaction_id).toBe(ORDER_ID);
    expect(body.visa).not.toHaveProperty('external_transaction_id');
    expect(body).not.toHaveProperty('external_tx_id');
  });

  it('omits external_transaction_id when --external-transaction-id is not supplied', async () => {
    const apiClient = mockApiClient({
      '/payment-tokens/create': VISA_PENDING,
      '/payment-tokens/ptk_visa_001': VISA_ACTIVE,
    });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerVisaCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await runWithPoll(() =>
      program.parseAsync(baseArgs(['--idempotency-key', 'idem_visa_plain'])),
    );

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('external_transaction_id');
  });
});

// ------------------------------------------------------------
// evo-create
// ------------------------------------------------------------

describe('payment-tokens evo-create — --external-transaction-id passthrough (R11.1)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_evo_1',
    '--amount-cents', '12345',
    ...extra,
  ];

  it('forwards --external-transaction-id at the TOP level as external_transaction_id', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync(
      baseArgs(['--external-transaction-id', ORDER_ID, '--idempotency-key', 'idem_evo']),
    );

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.external_transaction_id).toBe(ORDER_ID);
    expect(body).not.toHaveProperty('external_tx_id');
  });

  it('omits external_transaction_id when --external-transaction-id is not supplied', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync(baseArgs(['--idempotency-key', 'idem_evo_plain']));

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('external_transaction_id');
  });
});

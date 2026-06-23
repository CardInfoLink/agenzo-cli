/**
 * Property tests for token-cli: Properties 4, 5, 6, 7 (design.md).
 *
 * - Property 4: idempotency-key enforcement — write commands + --yes + missing --idempotency-key → throws PARAM_IDEMPOTENCY_KEY_REQUIRED, no request sent.
 * - Property 5: output channel purity — json mode stdout is valid JSON (with profile/endpoint), stderr silent; table status lines in stderr.
 * - Property 6: error-code consolidation — error codes belong to catalog, exit codes mapped by exitCodeFor.
 * - Property 7: get-create verbatim alignment — formatPaymentToken vs formatPaymentTokenGet differences preserved.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import {
  CliError,
  IdempotencyKeyRequiredError,
  UserCancelError,
  NetworkError,
  exitCodeFor,
  toErrorEnvelope,
  notify,
  resolveFormat,
} from '@agenzo/cli-core';
import { registerDisableCommand } from '../src/payment-methods/disable.js';
import { registerAddCommand } from '../src/payment-methods/add.js';
import { registerCreateCommand, formatPaymentToken, mapTokenType, usdToCents } from '../src/payment-tokens/create.js';
import { registerRevokeCommand } from '../src/payment-tokens/revoke.js';
import { formatPaymentTokenGet } from '../src/payment-tokens/get.js';

// ============================================================
// Test Helpers
// ============================================================

function buildProgram(): Command {
  const root = new Command();
  root.exitOverride();
  root.option('--format <format>');
  root.option('--yes');
  root.option('--verbose');
  // Wire the preAction hook to set AGENZO_FORMAT (mirrors index.ts)
  root.hook('preAction', (thisCommand) => {
    const flag = thisCommand.opts().format as string | undefined;
    process.env.AGENZO_FORMAT = resolveFormat(flag);
  });
  return root;
}

function mockApiClient() {
  return {
    get: vi.fn().mockResolvedValue({ success: true, data: {} }),
    post: vi.fn().mockResolvedValue({ success: true, data: {} }),
  };
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
  return { spy, text: () => chunks.join('') };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  return { spy, text: () => chunks.join('\n') };
}

// ============================================================
// Property 4: idempotency-key enforcement
// **Validates: Requirements 6.3**
// ============================================================

describe('Property 4: idempotency-key enforcement — write commands + --yes + missing --idempotency-key', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('payment-methods disable --yes without --idempotency-key → IdempotencyKeyRequiredError, no request', async () => {
    const api = mockApiClient();
    const root = buildProgram();
    const group = root.command('payment-methods');
    registerDisableCommand(group, { apiClient: api as never });

    await expect(
      root.parseAsync(['node', 'cli', '--yes', 'payment-methods', 'disable', 'pm_123', '--api-key', 'k']),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);

    expect(api.post).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('payment-methods add --yes without --idempotency-key → IdempotencyKeyRequiredError, no request', async () => {
    const api = mockApiClient();
    const root = buildProgram();
    const group = root.command('payment-methods');
    registerAddCommand(group, { apiClient: api as never });

    await expect(
      root.parseAsync([
        'node', 'cli', '--yes', 'payment-methods', 'add',
        '--api-key', 'k',
        '--email', 'a@b.com',
        '--card-number', '4111111111111111',
        '--expiry', '1225',
        '--cvv', '123',
      ]),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);

    expect(api.post).not.toHaveBeenCalled();
  });

  it('payment-tokens create --yes without --idempotency-key → IdempotencyKeyRequiredError, no request', async () => {
    const api = mockApiClient();
    // Mock the feature check + payment method list for create to proceed to the idempotency check
    api.get.mockImplementation((path: string) => {
      if (path === '/features/vcn') return Promise.resolve({ success: true, data: { enabled: true } });
      if (path === '/payment-methods') return Promise.resolve({ success: true, data: [{ id: 'pm_1', status: 'ACTIVE', last4: '1234', type: 'card' }] });
      return Promise.resolve({ success: true, data: {} });
    });

    const root = buildProgram();
    const group = root.command('payment-tokens');
    registerCreateCommand(group, { apiClient: api as never });

    await expect(
      root.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'create',
        '--api-key', 'k',
        '--type', 'vcn',
        '--amount', '10.00',
        '--payment-method-id', 'pm_1',
      ]),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);

    // apiClient.post (the actual write) must NOT have been called
    expect(api.post).not.toHaveBeenCalled();
  });

  it('payment-tokens revoke --yes without --idempotency-key → IdempotencyKeyRequiredError, no request', async () => {
    const api = mockApiClient();
    const root = buildProgram();
    const group = root.command('payment-tokens');
    registerRevokeCommand(group, { apiClient: api as never });

    await expect(
      root.parseAsync(['node', 'cli', '--yes', 'payment-tokens', 'revoke', 'pt_abc', '--api-key', 'k']),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);

    expect(api.post).not.toHaveBeenCalled();
  });

  it('IdempotencyKeyRequiredError code is PARAM_IDEMPOTENCY_KEY_REQUIRED', () => {
    const e = new IdempotencyKeyRequiredError('payment-methods disable');
    expect(e.code).toBe('PARAM_IDEMPOTENCY_KEY_REQUIRED');
    expect(e.message).toContain('--idempotency-key');
    expect(e.message).toContain('payment-methods disable');
  });
});

// ============================================================
// Property 5: output channel purity
// **Validates: Requirements 6.1**
// ============================================================

describe('Property 5: output channel purity — json mode stdout purity / table status on stderr', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('notify in json mode does NOT write to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('json', 'success', 'Something');
    notify('json', 'info', 'Something else');
    notify('json', 'warning', 'Careful');
    expect(spy).not.toHaveBeenCalled();
  });

  it('notify in table mode writes status lines to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('table', 'success', 'Done');
    notify('table', 'info', 'Note');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain('✓');
    expect(spy.mock.calls[1][0]).toContain('ℹ');
  });

  it('json output from payment-methods disable contains valid JSON with profile/endpoint on stdout', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: true,
      data: { status: 'DISABLED', revoked_tokens_count: 2 },
    });

    const stdout = captureStdout();
    const stderr = captureStderr();

    const root = buildProgram();
    const group = root.command('payment-methods');
    registerDisableCommand(group, { apiClient: api as never });

    await root.parseAsync([
      'node', 'cli', '--yes', '--format', 'json',
      'payment-methods', 'disable', 'pm_xyz',
      '--api-key', 'k',
      '--idempotency-key', 'idem-1',
    ]);

    stdout.spy.mockRestore();
    stderr.spy.mockRestore();

    // stdout must be a single valid JSON
    const json = JSON.parse(stdout.text().trim());
    expect(json).toHaveProperty('profile');
    expect(json).toHaveProperty('endpoint');
    expect(json).toHaveProperty('status', 'DISABLED');
    expect(json).toHaveProperty('revoked_tokens_count', 2);

    // stderr must be empty (json mode silent)
    expect(stderr.text()).toBe('');
  });

  it('table output from payment-methods disable puts status on stderr and keyValue on stdout', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: true,
      data: { status: 'DISABLED', revoked_tokens_count: 0 },
    });

    const stdout = captureStdout();
    const stderr = captureStderr();

    const root = buildProgram();
    const group = root.command('payment-methods');
    registerDisableCommand(group, { apiClient: api as never });

    await root.parseAsync([
      'node', 'cli', '--yes', '--format', 'table',
      'payment-methods', 'disable', 'pm_xyz',
      '--api-key', 'k',
      '--idempotency-key', 'idem-1',
    ]);

    stdout.spy.mockRestore();
    stderr.spy.mockRestore();

    // stdout has business data
    const stdoutText = stdout.text();
    expect(stdoutText).toContain('Status');
    expect(stdoutText).toContain('DISABLED');

    // stderr has the status line
    const stderrText = stderr.text();
    expect(stderrText).toContain('✓');
    expect(stderrText).toContain('Payment method pm_xyz disabled');
  });
});

// ============================================================
// Property 6: error-code consolidation
// **Validates: Requirements 6.2**
// ============================================================

describe('Property 6: error-code consolidation — all error codes ∈ catalog, exit codes mapped correctly', () => {
  it('CliError.fromApi maps HTTP 401 (api-key) → KEY_INVALID', () => {
    const err = CliError.fromApi({ success: false, statusCode: 401, data: null } as never, { auth: 'api-key' });
    expect(err.code).toBe('KEY_INVALID');
  });

  it('CliError.fromApi maps HTTP 403 → KEY_SCOPE_DENIED', () => {
    const err = CliError.fromApi({ success: false, statusCode: 403, data: null } as never, { auth: 'api-key' });
    expect(err.code).toBe('KEY_SCOPE_DENIED');
  });

  it('CliError.fromApi maps HTTP 404 → RESOURCE_NOT_FOUND', () => {
    const err = CliError.fromApi({ success: false, statusCode: 404, data: null } as never, { auth: 'api-key' });
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('CliError.fromApi maps HTTP 429 → RATE_LIMITED', () => {
    const err = CliError.fromApi({ success: false, statusCode: 429, data: null } as never, { auth: 'api-key' });
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('CliError.fromApi maps HTTP 500 → INTERNAL_ERROR', () => {
    const err = CliError.fromApi({ success: false, statusCode: 500, data: null } as never, { auth: 'api-key' });
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  it('exitCodeFor: KEY_* → 3', () => {
    expect(exitCodeFor(new CliError('KEY_INVALID', 'msg'))).toBe(3);
    expect(exitCodeFor(new CliError('KEY_SCOPE_DENIED', 'msg'))).toBe(3);
  });

  it('exitCodeFor: TOKEN_* / CLIENT_* / PARAM_* → 1', () => {
    expect(exitCodeFor(new CliError('TOKEN_FEATURE_DISABLED', 'msg'))).toBe(1);
    expect(exitCodeFor(new CliError('CLIENT_NO_PAYMENT_METHOD', 'msg'))).toBe(1);
    expect(exitCodeFor(new CliError('CLIENT_CARD_NOT_MATCHED', 'msg'))).toBe(1);
    expect(exitCodeFor(new CliError('PARAM_INVALID', 'msg'))).toBe(1);
    expect(exitCodeFor(new CliError('PARAM_IDEMPOTENCY_KEY_REQUIRED', 'msg'))).toBe(1);
  });

  it('exitCodeFor: UPSTREAM_ERROR / INTERNAL_ERROR / RATE_LIMITED → 4', () => {
    expect(exitCodeFor(new CliError('UPSTREAM_ERROR', 'msg'))).toBe(4);
    expect(exitCodeFor(new CliError('INTERNAL_ERROR', 'msg'))).toBe(4);
    expect(exitCodeFor(new CliError('RATE_LIMITED', 'msg'))).toBe(4);
  });

  it('exitCodeFor: CLIENT_ABORTED → 5', () => {
    expect(exitCodeFor(new UserCancelError())).toBe(5);
    expect(exitCodeFor(new CliError('CLIENT_ABORTED', 'msg'))).toBe(5);
  });

  it('exitCodeFor: UPGRADE_REQUIRED → 2', () => {
    expect(exitCodeFor(new CliError('UPGRADE_REQUIRED', 'msg'))).toBe(2);
  });

  it('toErrorEnvelope produces valid code_num for all token-cli error codes', () => {
    const codes = [
      'KEY_INVALID', 'KEY_SCOPE_DENIED', 'TOKEN_FEATURE_DISABLED',
      'CLIENT_NO_PAYMENT_METHOD', 'CLIENT_CARD_NOT_MATCHED',
      'PARAM_IDEMPOTENCY_KEY_REQUIRED', 'UPSTREAM_ERROR', 'INTERNAL_ERROR',
      'RATE_LIMITED', 'CLIENT_ABORTED',
    ] as const;
    for (const code of codes) {
      const envelope = toErrorEnvelope(new CliError(code, 'test'));
      expect(envelope.error.code).toBe(code);
      // code_num must be a positive integer (assigned from the catalog)
      expect(typeof envelope.error.code_num).toBe('number');
      expect(envelope.error.code_num).toBeGreaterThan(0);
    }
  });

  it('all error codes used by token-cli produce envelopes (proving catalog membership)', () => {
    const tokenCliCodes = [
      'KEY_INVALID', 'KEY_SCOPE_DENIED', 'RESOURCE_NOT_FOUND',
      'PARAM_INVALID', 'PARAM_IDEMPOTENCY_KEY_REQUIRED',
      'TOKEN_FEATURE_DISABLED', 'CLIENT_NO_PAYMENT_METHOD',
      'CLIENT_CARD_NOT_MATCHED', 'CLIENT_ABORTED',
      'UPSTREAM_ERROR', 'INTERNAL_ERROR', 'RATE_LIMITED',
    ] as const;
    for (const code of tokenCliCodes) {
      const envelope = toErrorEnvelope(new CliError(code, `msg for ${code}`));
      expect(envelope.error.code).toBe(code);
      expect(envelope.error.code_num).toBeGreaterThan(0);
      expect(envelope.error.message).toContain(code.toLowerCase().includes('test') ? '' : '');
      // Ensure message is non-empty
      expect(envelope.error.message.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// Property 7: get-create verbatim alignment
// **Validates: Requirements 4.2**
// ============================================================

describe('Property 7: payment-tokens get vs create keyValue differences preserved verbatim', () => {
  const vcnData: Record<string, unknown> = {
    id: 'pt_vcn_001',
    type: 'vcn',
    status: 'ACTIVE',
    vcn: {
      id: 'pt_vcn_001',
      card_number: '4111111111112222',
      last_four: '2222',
      expiry: '1225',
      cvc: '456',
      amount_limit: 2500,
      balance: 2000,
      currency: 'USD',
      status: 'ACTIVE',
    },
  };

  it('create uses "Payment Token ID" as the top key; get uses "Token ID"', () => {
    const createOutput = formatPaymentToken(vcnData);
    const getOutput = formatPaymentTokenGet(vcnData);

    expect(createOutput).toContain('Payment Token ID');
    expect(createOutput).not.toMatch(/^Token ID\b/m);

    expect(getOutput).toContain('Token ID');
    // "Token ID" must NOT be preceded by "Payment " in the get output
    expect(getOutput).not.toContain('Payment Token ID');
  });

  it('get includes "Last 4" for VCN; create does NOT', () => {
    const createOutput = formatPaymentToken(vcnData);
    const getOutput = formatPaymentTokenGet(vcnData);

    expect(getOutput).toContain('Last 4');
    expect(getOutput).toContain('2222');

    expect(createOutput).not.toContain('Last 4');
  });

  it('create uses "$" prefix on Limit; get does NOT use "$" prefix on Limit/Balance', () => {
    const createOutput = formatPaymentToken(vcnData);
    const getOutput = formatPaymentTokenGet(vcnData);

    // create: Limit should have "$" prefix
    const createLimitLine = createOutput.split('\n').find((l) => l.trim().startsWith('Limit'));
    expect(createLimitLine).toContain('$');

    // get: Limit/Balance should NOT have "$" prefix
    const getLimitLine = getOutput.split('\n').find((l) => l.trim().startsWith('Limit'));
    const getBalanceLine = getOutput.split('\n').find((l) => l.trim().startsWith('Balance'));
    expect(getLimitLine).toBeDefined();
    expect(getBalanceLine).toBeDefined();
    // The value portion should be plain numeric ("25.00"), not "$25.00"
    expect(getLimitLine!.replace('Limit', '').trim()).not.toMatch(/^\$/);
    expect(getBalanceLine!.replace('Balance', '').trim()).not.toMatch(/^\$/);
  });

  it('get has a "Balance" field for VCN; create does NOT', () => {
    const createOutput = formatPaymentToken(vcnData);
    const getOutput = formatPaymentTokenGet(vcnData);

    expect(getOutput).toContain('Balance');
    expect(createOutput).not.toContain('Balance');
  });

  it('network_token: both use same keys ("Payment Token ID" in create, "Token ID" in get)', () => {
    const ntData: Record<string, unknown> = {
      id: 'pt_nt_001',
      type: 'network_token',
      network_token: {
        payment_brand: 'Visa',
        eci: '05',
        token_cryptogram: 'abc123',
        expiry_date: '1226',
        value: 'tok_xyz',
      },
    };

    const createOutput = formatPaymentToken(ntData);
    const getOutput = formatPaymentTokenGet(ntData);

    expect(createOutput).toContain('Payment Token ID');
    expect(getOutput).toContain('Token ID');
    expect(getOutput).not.toContain('Payment Token ID');
  });

  it('x402: both use same keys with ID difference preserved', () => {
    const x402Data: Record<string, unknown> = {
      id: 'pt_x402_001',
      type: 'x402',
      status: 'ACTIVE',
      x402: {
        signature_value: 'sig_abc_123',
        status: 'ACTIVE',
      },
    };

    const createOutput = formatPaymentToken(x402Data);
    const getOutput = formatPaymentTokenGet(x402Data);

    expect(createOutput).toContain('Payment Token ID');
    expect(getOutput).toContain('Token ID');
    expect(getOutput).not.toContain('Payment Token ID');
  });
});

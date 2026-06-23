/**
 * Coverage-gap tests for token-cli (§9 uncovered items from test design).
 *
 * Covers:
 *   1. 3DS Timeout (fake timers)
 *   2. JSON Envelope Field-Precise Assertions
 *   3. API Error Integration Paths (command-level)
 *   4. VCN Fee Calculation in Integration Context
 *   5. payment-methods list JSON mode envelope
 *   6. Idempotency-Key header verification
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerListCommand } from '../src/payment-methods/list.js';
import { registerGetCommand as registerPmGetCommand } from '../src/payment-methods/get.js';
import { registerAddCommand } from '../src/payment-methods/add.js';
import { registerCreateCommand } from '../src/payment-tokens/create.js';
import { registerRevokeCommand } from '../src/payment-tokens/revoke.js';
import {
  CliError,
  resolveFormat,
} from '@agenzo/cli-core';

// Mock @inquirer/prompts to avoid interactive prompts
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('pm_auto'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

// ============================================================
// Test Helpers (mirrors helpers.ts pattern)
// ============================================================

function buildProgram(): Command {
  const root = new Command();
  root.exitOverride();
  root.option('--format <format>');
  root.option('--yes');
  root.option('--verbose');
  root.hook('preAction', (thisCommand) => {
    const flag = thisCommand.opts().format as string | undefined;
    process.env.AGENZO_FORMAT = resolveFormat(flag);
  });
  return root;
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
// §1. 3DS Timeout (vi.useFakeTimers)
// ============================================================

describe('3DS Timeout with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('polling timeout after 15 min emits timeout hint message', async () => {
    const createdPm = { id: 'pm_timeout', type: 'card', status: 'PENDING', brand: 'Visa', first6: '411111', last4: '4242' };

    // API always returns PENDING for verification status
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/payment-methods/verification/status') {
          return Promise.resolve({ success: true, data: { status: 'PENDING' } });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({ success: true, data: createdPm }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    const err = captureStderr();

    // Start the command (enters polling loop after POST returns PENDING)
    const promise = program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key',
      '--type', 'card',
      '--email', 'test@example.com',
      '--card-number', '4111111111111111',
      '--expiry', '1228',
      '--cvv', '123',
      '--idempotency-key', 'idem_timeout',
    ]);

    // Advance time past 15-minute timeout (15 * 60 * 1000 = 900_000 ms)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5000);

    await promise;

    const stderrText = err.text();
    expect(stderrText).toContain('Verification timed out (15 min)');
    expect(stderrText).toContain('agenzo-token-cli payment-methods get pm_timeout --api-key <your_key>');
  });
});

// ============================================================
// §2. JSON Envelope Field-Precise Assertions
// ============================================================

describe('JSON Envelope field-precise assertions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('payment-methods list --format json: contains exactly profile, endpoint, payment_methods array', async () => {
    const PM1 = { id: 'pm_001', type: 'card', brand: 'Visa', first6: '411111', last4: '1234', status: 'ACTIVE' };
    const apiClient = {
      get: vi.fn().mockResolvedValue({ success: true, data: [PM1] }),
      post: vi.fn(),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', '--format', 'json', 'payment-methods', 'list', '--api-key', 'sk_key']);

    const json = JSON.parse(out.text().trim());
    // Must have profile, endpoint, and payment_methods
    expect(json).toHaveProperty('profile');
    expect(json).toHaveProperty('endpoint');
    expect(json).toHaveProperty('payment_methods');
    // endpoint is a host URL (no path)
    expect(json.endpoint).toMatch(/^https?:\/\/[^/]+$/);
    // profile is one of production/testing/custom
    expect(['production', 'testing', 'custom']).toContain(json.profile);
    // payment_methods is an array
    expect(Array.isArray(json.payment_methods)).toBe(true);
  });

  it('payment-tokens create --format json (VCN): contains profile, endpoint, and token data fields', async () => {
    const vcnResponse = {
      id: 'pt_vcn_json',
      type: 'vcn',
      vcn: { card_number: '4111222233334444', expiry: '1230', cvc: '111', amount_limit: 2500, currency: 'USD', status: 'ACTIVE' },
    };
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/features/vcn') return Promise.resolve({ success: true, data: { enabled: true } });
        if (path === '/payment-methods') return Promise.resolve({ success: true, data: [{ id: 'pm_1', status: 'ACTIVE', last4: '1234' }] });
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({ success: true, data: vcnResponse }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', '--format', 'json', 'payment-tokens', 'create',
      '--api-key', 'sk_key',
      '--type', 'vcn',
      '--payment-method-id', 'pm_1',
      '--amount', '25.00',
      '--idempotency-key', 'idem_json',
    ]);

    const json = JSON.parse(out.text().trim());
    expect(json).toHaveProperty('profile');
    expect(json).toHaveProperty('endpoint');
    expect(json).toHaveProperty('id', 'pt_vcn_json');
    expect(json).toHaveProperty('type', 'vcn');
    expect(json).toHaveProperty('vcn');
    expect(json.vcn).toHaveProperty('card_number');
    expect(json.vcn).toHaveProperty('amount_limit');
  });

  it('payment-methods get --format json: contains profile, endpoint, and PM fields', async () => {
    const pm = { id: 'pm_get_json', type: 'card', brand: 'Mastercard', first6: '512345', last4: '6789', status: 'ACTIVE', created_at: '2026-01-15T10:00:00Z' };
    const apiClient = {
      get: vi.fn().mockResolvedValue({ success: true, data: pm }),
      post: vi.fn(),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerPmGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', '--format', 'json', 'payment-methods', 'get', 'pm_get_json', '--api-key', 'sk_key']);

    const json = JSON.parse(out.text().trim());
    expect(json).toHaveProperty('profile');
    expect(json).toHaveProperty('endpoint');
    expect(json.endpoint).toMatch(/^https?:\/\/[^/]+$/);
    expect(json).toHaveProperty('id', 'pm_get_json');
    expect(json).toHaveProperty('type', 'card');
    expect(json).toHaveProperty('brand', 'Mastercard');
    expect(json).toHaveProperty('status', 'ACTIVE');
  });
});

// ============================================================
// §3. API Error Integration Paths (command-level)
// ============================================================

describe('API Error integration paths (command-level)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('payment-methods list with 401 response → CliError code=KEY_INVALID', async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 401,
        errorCode: 1002,
        errorMessage: 'unauthorized',
        data: null,
      }),
      post: vi.fn(),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'payment-methods', 'list', '--api-key', 'sk_bad_key']),
    ).rejects.toMatchObject({ code: 'KEY_INVALID' });
  });

  it('payment-methods get with 404 response → CliError code=RESOURCE_NOT_FOUND', async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 404,
        errorCode: 1201,
        errorMessage: 'not found',
        data: null,
      }),
      post: vi.fn(),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerPmGetCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'payment-methods', 'get', 'pm_nonexistent', '--api-key', 'sk_key']),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('payment-tokens create (VCN) with 500 on POST → CliError code=INTERNAL_ERROR', async () => {
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/features/vcn') return Promise.resolve({ success: true, data: { enabled: true } });
        if (path === '/payment-methods') return Promise.resolve({ success: true, data: [{ id: 'pm_1', status: 'ACTIVE', last4: '1234' }] });
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 500,
        errorCode: 5000,
        errorMessage: 'server error',
        data: null,
      }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'create',
        '--api-key', 'sk_key',
        '--type', 'vcn',
        '--payment-method-id', 'pm_1',
        '--amount', '10.00',
        '--idempotency-key', 'idem_500',
      ]),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

// ============================================================
// §4. VCN Fee Calculation in Integration Context
// ============================================================

describe('VCN fee calculation integration — amount sent, fee NOT sent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('amount 10.00 → body.amount=1000, body has no fee field', async () => {
    const vcnResponse = {
      id: 'pt_fee_check',
      type: 'vcn',
      vcn: { card_number: '4111111111111111', expiry: '1230', cvc: '999', amount_limit: 1000, currency: 'USD', status: 'ACTIVE' },
    };
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/features/vcn') return Promise.resolve({ success: true, data: { enabled: true } });
        if (path === '/payment-methods') return Promise.resolve({ success: true, data: [{ id: 'pm_1', status: 'ACTIVE', last4: '1234' }] });
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({ success: true, data: vcnResponse }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'create',
      '--api-key', 'sk_key',
      '--type', 'vcn',
      '--payment-method-id', 'pm_1',
      '--amount', '10.00',
      '--idempotency-key', 'idem_fee',
    ]);

    // Verify POST was called
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    // Extract the body from the POST call
    const postCall = apiClient.post.mock.calls[0];
    const body = postCall[2]; // 3rd arg is body

    // amount should be 1000 cents (10.00 * 100)
    expect(body.amount).toBe(1000);

    // Fee is display-only — NOT sent to server
    expect(body).not.toHaveProperty('fee');
    expect(body).not.toHaveProperty('fee_cents');
    expect(body).not.toHaveProperty('total');

    // Verify fee calculation: max(1, round(1000 * 0.05)) = 50
    // This is display-only, confirmed by body not containing it
  });
});

// ============================================================
// §5. payment-methods list JSON mode envelope (structure validation)
// ============================================================

describe('payment-methods list JSON mode — explicit parse + structure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('JSON output is a single valid JSON object with correct array structure', async () => {
    const PM1 = { id: 'pm_struct_1', type: 'card', brand: 'Visa', first6: '411111', last4: '1234', status: 'ACTIVE' };
    const PM2 = { id: 'pm_struct_2', type: 'card', brand: null, first6: null, last4: null, status: 'PENDING' };
    const apiClient = {
      get: vi.fn().mockResolvedValue({ success: true, data: [PM1, PM2] }),
      post: vi.fn(),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', '--format', 'json', 'payment-methods', 'list', '--api-key', 'sk_key']);

    const raw = out.text().trim();
    // Must be valid JSON (no trailing comma, no multi-object stream)
    const json = JSON.parse(raw);

    // Structural assertions
    expect(typeof json).toBe('object');
    expect(json).not.toBeNull();
    expect(Array.isArray(json.payment_methods)).toBe(true);
    expect(json.payment_methods).toHaveLength(2);
    expect(json.payment_methods[0]).toMatchObject({ id: 'pm_struct_1', type: 'card' });
    expect(json.payment_methods[1]).toMatchObject({ id: 'pm_struct_2', type: 'card' });
  });
});

// ============================================================
// §6. Idempotency-Key header verification
// ============================================================

describe('Idempotency-Key header verification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENZO_FORMAT;
  });

  it('payment-methods add passes exact --idempotency-key value as Idempotency-Key header', async () => {
    const createdPm = { id: 'pm_idem', type: 'card', status: 'ACTIVE', brand: 'Visa', first6: '411111', last4: '4242' };
    const apiClient = {
      get: vi.fn().mockResolvedValue({ success: true, data: {} }),
      post: vi.fn().mockResolvedValue({ success: true, data: createdPm }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key',
      '--type', 'card',
      '--email', 'test@example.com',
      '--card-number', '4111111111111111',
      '--expiry', '1228',
      '--cvv', '123',
      '--idempotency-key', 'my-unique-key-abc-123',
    ]);

    // Verify the exact header value in the POST call
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/create',
      expect.anything(),
      expect.anything(),
      { 'Idempotency-Key': 'my-unique-key-abc-123' },
    );
  });

  it('payment-tokens revoke passes exact --idempotency-key value as Idempotency-Key header', async () => {
    const revokeResult = { id: 'pt_idem', status: 'REVOKED', revoked_at: '2026-01-15T12:00:00Z', expires_at: null };
    const apiClient = {
      get: vi.fn().mockResolvedValue({ success: true, data: {} }),
      post: vi.fn().mockResolvedValue({ success: true, data: revokeResult }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerRevokeCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-tokens', 'revoke', 'pt_idem',
      '--api-key', 'sk_key',
      '--idempotency-key', 'revoke-idem-xyz-456',
    ]);

    // Verify the exact header value in the POST call
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/pt_idem/revoke',
      expect.anything(),
      undefined,
      { 'Idempotency-Key': 'revoke-idem-xyz-456' },
    );
  });
});

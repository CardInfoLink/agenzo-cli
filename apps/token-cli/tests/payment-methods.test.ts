import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { registerListCommand } from '../src/payment-methods/list.js';
import { registerGetCommand } from '../src/payment-methods/get.js';
import { registerDisableCommand } from '../src/payment-methods/disable.js';
import { registerAddCommand } from '../src/payment-methods/add.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
  // dropin terminal failures set process.exitCode; reset so it does not leak
  // into other tests or the vitest process exit code.
  process.exitCode = 0;
});

// ============================================================
// payment-methods list (§3.4.0.2)
// ============================================================

describe('payment-methods list', () => {
  const PM1 = { id: 'pm_001', type: 'card', brand: 'Visa', first6: '411111', last4: '1234', status: 'ACTIVE' };
  const PM2 = { id: 'pm_002', type: 'card', brand: null, first6: null, last4: null, status: 'PENDING' };

  it('happy path: GET /payment-methods with X-Api-Key, table output with headers', async () => {
    const apiClient = mockApiClient({ '/payment-methods': [PM1] });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'list', '--api-key', 'sk_test_key']);

    // Verify API call: GET method, path, auth header
    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-methods',
      { type: 'api-key', key: 'sk_test_key' },
      undefined,
    );

    // Verify table output contains headers and data
    const output = out.text();
    expect(output).toContain('ID');
    expect(output).toContain('Type');
    expect(output).toContain('Brand');
    expect(output).toContain('First 6');
    expect(output).toContain('Last 4');
    expect(output).toContain('Status');
    expect(output).toContain('pm_001');
    expect(output).toContain('Visa');
    expect(output).toContain('411111');
    expect(output).toContain('1234');
    expect(output).toContain('ACTIVE');
  });

  it('missing brand/first6/last4 renders as "-"', async () => {
    const apiClient = mockApiClient({ '/payment-methods': [PM2] });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'list', '--api-key', 'sk_key']);

    const output = out.text();
    // Missing brand/first6/last4 should show as '-'
    expect(output).toContain('pm_002');
    // Count occurrences of '-' — at least 3 for the missing fields
    const dashes = (output.match(/(?<!\w)-(?!\w)/g) || []).length;
    expect(dashes).toBeGreaterThanOrEqual(3);
  });

  it('empty list outputs info message without table', async () => {
    const apiClient = mockApiClient({ '/payment-methods': [] });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'list', '--api-key', 'sk_key']);

    const output = out.text();
    expect(output).toContain('No payment methods found');
    // Should NOT contain table headers
    expect(output).not.toMatch(/ID\s+Type\s+Brand/);
  });

  it('passes --member as query param member_id', async () => {
    const apiClient = mockApiClient({ '/payment-methods': [] });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerListCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'list', '--api-key', 'sk_key', '--member', 'mem_123']);

    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-methods',
      { type: 'api-key', key: 'sk_key' },
      { member_id: 'mem_123' },
    );
  });
});

// ============================================================
// payment-methods get (§3.4.0.3)
// ============================================================

describe('payment-methods get', () => {
  it('happy path: GET /payment-methods/<id> with keyValue output including conditional fields', async () => {
    const pm = { id: 'pm_abc', type: 'card', brand: 'Mastercard', first6: '512345', last4: '6789', status: 'ACTIVE', created_at: '2026-01-15T10:00:00Z' };
    const apiClient = mockApiClient({ '/payment-methods/pm_abc': pm });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'get', 'pm_abc', '--api-key', 'sk_key']);

    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-methods/pm_abc',
      { type: 'api-key', key: 'sk_key' },
    );

    const output = out.text();
    expect(output).toContain('pm_abc');
    expect(output).toContain('card');
    expect(output).toContain('Mastercard');
    expect(output).toContain('512345');
    expect(output).toContain('6789');
    expect(output).toContain('ACTIVE');
  });

  it('Brand/First 6/Last 4 omitted when fields are empty', async () => {
    const pm = { id: 'pm_xyz', type: 'card', brand: '', first6: '', last4: '', status: 'PENDING', created_at: '2026-01-15T10:00:00Z' };
    const apiClient = mockApiClient({ '/payment-methods/pm_xyz': pm });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'get', 'pm_xyz', '--api-key', 'sk_key']);

    const output = out.text();
    expect(output).toContain('pm_xyz');
    expect(output).toContain('PENDING');
    // These keys should NOT appear since the values are empty
    expect(output).not.toMatch(/Brand\s/);
    expect(output).not.toMatch(/First 6\s/);
    expect(output).not.toMatch(/Last 4\s/);
  });
});

// ============================================================
// payment-methods disable (§3.4.0.4)
// ============================================================

describe('payment-methods disable', () => {
  it('happy path: POST /payment-methods/<id>/disable with correct output', async () => {
    const disableResult = { status: 'DISABLED', revoked_tokens_count: 3 };
    const apiClient = mockApiClient({ '/payment-methods/pm_001/disable': disableResult });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerDisableCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'disable', 'pm_001', '--api-key', 'sk_key', '--idempotency-key', 'idem_1']);

    // Verify POST call with path and auth
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/pm_001/disable',
      { type: 'api-key', key: 'sk_key' },
      undefined,
      { 'Idempotency-Key': 'idem_1' },
    );

    // Verify success message in stderr
    const stderrText = err.text();
    expect(stderrText).toContain('Payment method pm_001 disabled');

    // Verify keyValue output
    const output = out.text();
    expect(output).toContain('DISABLED');
    expect(output).toContain('3');
  });

  it('revoked_tokens_count defaults to 0 when missing', async () => {
    const disableResult = { status: 'DISABLED' };
    const apiClient = mockApiClient({ '/payment-methods/pm_002/disable': disableResult });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerDisableCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-methods', 'disable', 'pm_002', '--api-key', 'sk_key', '--idempotency-key', 'idem_2']);

    const output = out.text();
    expect(output).toContain('0');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerDisableCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', '--yes', 'payment-methods', 'disable', 'pm_001', '--api-key', 'sk_key']),
    ).rejects.toThrow('--idempotency-key');

    // Must not send any request
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-methods add (§3.4.0.1)
// ============================================================

describe('payment-methods add', () => {
  it('happy path: POST /payment-methods/create with created state output', async () => {
    // Return status ACTIVE to skip 3DS polling in this test (3DS tested separately)
    const createdPm = { id: 'pm_new', type: 'card', status: 'ACTIVE', brand: 'Visa', first6: '411111', last4: '4242' };
    const apiClient = mockApiClient({ '/payment-methods/create': createdPm });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key',
      '--type', 'card',
      '--email', 'test@example.com',
      '--card-number', '4111111111111111',
      '--expiry', '1228',
      '--cvv', '123',
      '--idempotency-key', 'idem_add',
    ]);

    // Verify POST call
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/create',
      { type: 'api-key', key: 'sk_key' },
      expect.objectContaining({ type: 'card', email: 'test@example.com' }),
      { 'Idempotency-Key': 'idem_add' },
    );

    // Verify output messages
    const stderrText = err.text();
    expect(stderrText).toContain('Payment method created');
    expect(stderrText).toContain('Complete 3DS verification via email to activate');

    const output = out.text();
    expect(output).toContain('pm_new');
    expect(output).toContain('ACTIVE');
  });

  it('3DS polling: ACTIVE state outputs activation message', async () => {
    const createdPm = { id: 'pm_3ds', type: 'card', status: 'PENDING', brand: 'Visa', first6: '411111', last4: '4242' };
    const activatedPm = { ...createdPm, status: 'ACTIVE' };

    const apiClient = {
      get: vi.fn()
        // First GET: verification status → ACTIVE
        .mockImplementation((path: string) => {
          if (path === '/payment-methods/verification/status') {
            return Promise.resolve({ success: true, data: { status: 'ACTIVE' } });
          }
          if (path === '/payment-methods/pm_3ds') {
            return Promise.resolve({ success: true, data: activatedPm });
          }
          return Promise.resolve({ success: true, data: {} });
        }),
      post: vi.fn().mockResolvedValue({ success: true, data: createdPm }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key',
      '--type', 'card',
      '--email', 'test@example.com',
      '--card-number', '4111111111111111',
      '--expiry', '1228',
      '--cvv', '123',
      '--idempotency-key', 'idem_3ds',
    ]);

    const stderrText = err.text();
    expect(stderrText).toContain('Payment method created');
    expect(stderrText).toContain('Payment method activated');
  });

  it('3DS polling: FAILED state outputs failure message', async () => {
    const createdPm = { id: 'pm_fail', type: 'card', status: 'PENDING' };

    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/payment-methods/verification/status') {
          return Promise.resolve({ success: true, data: { status: 'FAILED' } });
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

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key',
      '--type', 'card',
      '--email', 'test@example.com',
      '--card-number', '4111111111111111',
      '--expiry', '1228',
      '--cvv', '123',
      '--idempotency-key', 'idem_fail',
    ]);

    const stderrText = err.text();
    expect(stderrText).toContain('3DS verification failed');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-methods', 'add',
        '--api-key', 'sk_key',
        '--type', 'card',
        '--email', 'test@example.com',
        '--card-number', '4111111111111111',
        '--expiry', '1228',
        '--cvv', '123',
      ]),
    ).rejects.toThrow('--idempotency-key');

    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-methods add --mode dropin (§3.4.0.1, Drop-in session)
// ============================================================

describe('payment-methods add --mode dropin', () => {
  const SESSION = {
    id: 'pm_dropin',
    session_id: 'sess_abc123',
    merchant_trans_id: 'T5060112345678',
    status: 'PENDING',
  };

  /** apiClient mock: dropin/create returns a session; verification/status returns `statusData`. */
  function dropinClient(statusData: Record<string, unknown>) {
    return {
      post: vi.fn().mockImplementation((path: string) => {
        if (path === '/payment-methods/dropin/create') {
          return Promise.resolve({ success: true, data: SESSION });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/payment-methods/verification/status') {
          return Promise.resolve({ success: true, data: statusData });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
    };
  }

  it('rejects an unknown --mode without calling the API', async () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'payment-methods', 'add',
        '--api-key', 'sk_key', '--mode', 'bogus',
      ]),
    ).rejects.toThrow(/Expected "manual" or "dropin"/);

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('happy path: POST /payment-methods/dropin/create with {email}, prints Session ID, polls to ACTIVE', async () => {
    const apiClient = dropinClient({
      id: 'pm_dropin',
      status: 'ACTIVE',
      brand: 'Visa',
      first6: '411111',
      last4: '4242',
    });

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--mode', 'dropin',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    // dropin/create called with {email} only (no card details / idempotency key)
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/dropin/create',
      { type: 'api-key', key: 'sk_key' },
      { email: 'user@example.com' },
    );

    // polls verification/status by the returned pm id
    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-methods/verification/status',
      { type: 'api-key', key: 'sk_key' },
      { payment_method_id: 'pm_dropin' },
    );

    const errText = err.text();
    expect(errText).toContain('Drop-in session created');
    expect(errText).toContain('Payment method activated');

    const outText = out.text();
    expect(outText).toContain('sess_abc123'); // Session ID printed
    expect(outText).toContain('pm_dropin');
    expect(outText).toContain('Visa');
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
  });

  it('does not require --idempotency-key even in --yes mode', async () => {
    const apiClient = dropinClient({ id: 'pm_dropin', status: 'ACTIVE' });

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-methods', 'add',
      '--mode', 'dropin',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    // Reached the API call instead of throwing IdempotencyKeyRequiredError.
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/dropin/create',
      { type: 'api-key', key: 'sk_key' },
      { email: 'user@example.com' },
    );
  });

  it('FAILED terminal status: error message + exit code 1', async () => {
    const apiClient = dropinClient({ id: 'pm_dropin', status: 'FAILED' });

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--mode', 'dropin',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    expect(err.text()).toContain('Failed to add payment method');
    expect(out.text()).toContain('pm_dropin'); // PM ID hint
    expect(process.exitCode).toBe(1);
  });

  it('EXPIRED terminal status: error message + exit code 1', async () => {
    const apiClient = dropinClient({ id: 'pm_dropin', status: 'EXPIRED' });

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--mode', 'dropin',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    expect(err.text()).toContain('Session expired before the payment method was added');
    expect(out.text()).toContain('pm_dropin');
    expect(process.exitCode).toBe(1);
  });
});

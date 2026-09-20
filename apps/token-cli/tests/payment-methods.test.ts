import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CliError } from '@agenzo/cli-core';
import { registerListCommand } from '../src/payment-methods/list.js';
import { registerGetCommand } from '../src/payment-methods/get.js';
import { registerDisableCommand } from '../src/payment-methods/disable.js';
import { registerAddCommand } from '../src/payment-methods/add.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, parseJsonOutput } from './helpers.js';

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
// payment-methods add — hosted binding (default; EVO + Visa merged)
// ============================================================

describe('payment-methods add (hosted binding, default)', () => {
  it('opens a hosted binding session, prints link_url, polls to ACTIVE', async () => {
    const sessionPm = { id: 'pm_hb', status: 'PENDING', link_url: 'https://app/payment/bind?pm=pm_hb&t=tok' };
    const activePm = { id: 'pm_hb', type: 'card', status: 'ACTIVE', brand: 'Visa', first6: '411111', last4: '4242' };

    const apiClient = {
      post: vi.fn().mockResolvedValue({ success: true, data: sessionPm }),
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/payment-methods/verification/status') {
          return Promise.resolve({ success: true, data: activePm });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key',
      '--email', 'test@example.com',
    ]);

    // 走品牌中立的托管绑卡端点，不再本地收卡。
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/binding-session',
      { type: 'api-key', key: 'sk_key' },
      { email: 'test@example.com' },
    );
    // 不碰任何本地收卡 / dropin/create / create 端点。
    expect(apiClient.post).not.toHaveBeenCalledWith(
      '/payment-methods/create',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    const stderrText = err.text();
    expect(stderrText).toContain('Hosted binding session created');
    expect(stderrText).toContain('Payment method activated');
    const output = out.text();
    expect(output).toContain('pm_hb');
    expect(output).toContain('https://app/payment/bind?pm=pm_hb&t=tok');
  });

  it('passes --member as member_id when given', async () => {
    const sessionPm = { id: 'pm_hb2', status: 'PENDING', link_url: 'https://app/x' };
    const apiClient = {
      post: vi.fn().mockResolvedValue({ success: true, data: sessionPm }),
      get: vi.fn().mockResolvedValue({ success: true, data: { id: 'pm_hb2', status: 'ACTIVE' } }),
    };
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--api-key', 'sk_key', '--email', 'u@e.com', '--member', 'user-42',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/binding-session',
      { type: 'api-key', key: 'sk_key' },
      { email: 'u@e.com', member_id: 'user-42' },
    );
  });

  it('FAILED terminal status: error message + exit code 1', async () => {
    const sessionPm = { id: 'pm_hb3', status: 'PENDING', link_url: 'https://app/x' };
    const apiClient = {
      post: vi.fn().mockResolvedValue({ success: true, data: sessionPm }),
      get: vi.fn().mockResolvedValue({ success: true, data: { id: 'pm_hb3', status: 'FAILED' } }),
    };
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);
    captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add', '--api-key', 'sk_key', '--email', 'u@e.com',
    ]);

    expect(err.text()).toContain('Failed to add payment method');
    expect(process.exitCode).toBe(1);
  });

  it('does not require --idempotency-key even in --yes mode', async () => {
    const sessionPm = { id: 'pm_hb4', status: 'PENDING', link_url: 'https://app/x' };
    const apiClient = {
      post: vi.fn().mockResolvedValue({ success: true, data: sessionPm }),
      get: vi.fn().mockResolvedValue({ success: true, data: { id: 'pm_hb4', status: 'ACTIVE' } }),
    };
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-methods', 'add', '--api-key', 'sk_key', '--email', 'u@e.com',
    ]);

    // hosted binding 是签发链接 + 轮询，非本地写卡，故不需要幂等键。
    expect(apiClient.post).toHaveBeenCalledOnce();
  });
});

describe('payment-methods add --payment-brand unionpay', () => {
  it('rejects an unknown --payment-brand without calling the API', async () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'payment-methods', 'add',
        '--api-key', 'sk_key', '--payment-brand', 'bogus',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('--payment-brand unionpay without --member: omits member_id, lets the server rule', async () => {
    // CLI 侧不复制服务端规则：member_id 是否必需由平台判定（UnionPay 的
    // consumer_identity_value 由它派生，缺失会被 INVALID_REQUEST 拒绝）。CLI 只是不发
    // 这个字段——尤其不能发 ""，那会把"没传"变成一个参数错误。
    const activatedPm = {
      id: 'pm_upi_nomember', type: 'card', status: 'ACTIVE', payment_brand: 'unionpay',
    };
    const apiClient = mockApiClient({
      '/payment-methods/create': { id: 'pm_upi_nomember', status: 'PENDING', payment_brand: 'unionpay' },
    });
    apiClient.get = vi.fn().mockResolvedValue({ success: true, data: activatedPm });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-methods', 'add',
      '--api-key', 'sk_key', '--payment-brand', 'unionpay', '--email', 'user@example.com',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/create',
      { type: 'api-key', key: 'sk_key' },
      { type: 'card', payment_brand: 'unionpay', email: 'user@example.com' },
    );
  });

  it('happy path: POST create(payment_brand=unionpay, member_id), prints enroll_url, polls until ACTIVE', async () => {
    const unionpayPm = {
      id: 'pm_upi_1',
      type: 'card',
      status: 'PENDING',
      payment_brand: 'unionpay',
      enroll_url: 'https://upi.example.com/enroll/abc',
      correlation_id: 'corr_123',
    };
    const activatedPm = {
      id: 'pm_upi_1',
      type: 'card',
      status: 'ACTIVE',
      payment_brand: 'unionpay',
      brand: 'UnionPay',
      first6: '625094',
      last4: '0105',
    };
    const apiClient = mockApiClient({ '/payment-methods/create': unionpayPm });
    // Mock GET for polling — returns ACTIVE immediately
    apiClient.get = vi.fn().mockResolvedValue({ success: true, data: activatedPm });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-methods', 'add',
      '--payment-brand', 'unionpay',
      '--member', 'mem_123',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/create',
      { type: 'api-key', key: 'sk_key' },
      { type: 'card', payment_brand: 'unionpay', member_id: 'mem_123', email: 'user@example.com' },
    );

    // Polls GET /payment-methods/{id} at least once
    expect(apiClient.get).toHaveBeenCalled();

    const errText = err.text();
    expect(errText).toContain('Card binding initiated');
    expect(errText).toContain('Payment method activated');
  });

  it('does not require --idempotency-key even in --yes mode', async () => {
    const unionpayPm = {
      id: 'pm_upi_2',
      status: 'PENDING',
      payment_brand: 'unionpay',
      enroll_url: 'https://upi.example.com/enroll/xyz',
      correlation_id: 'corr_456',
    };
    const apiClient = mockApiClient({ '/payment-methods/create': unionpayPm });
    apiClient.get = vi.fn().mockResolvedValue({ success: true, data: { ...unionpayPm, status: 'ACTIVE', brand: 'UnionPay' } });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-methods', 'add',
      '--payment-brand', 'unionpay',
      '--member', 'mem_456',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    // Reached the API call instead of throwing IdempotencyKeyRequiredError,
    // and no Idempotency-Key header was sent.
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-methods/create',
      { type: 'api-key', key: 'sk_key' },
      { type: 'card', payment_brand: 'unionpay', member_id: 'mem_456', email: 'user@example.com' },
    );
  });

  it('--format json: stdout carries id/status/rail/enroll_url/correlation_id', async () => {
    const unionpayPm = {
      id: 'pm_upi_3',
      type: 'card',
      status: 'PENDING',
      payment_brand: 'unionpay',
      enroll_url: 'https://upi.example.com/enroll/json',
      correlation_id: 'corr_789',
    };
    const activatedPm = {
      id: 'pm_upi_3',
      type: 'card',
      status: 'ACTIVE',
      payment_brand: 'unionpay',
      brand: 'UnionPay',
      first6: '625094',
      last4: '0105',
    };
    const apiClient = mockApiClient({ '/payment-methods/create': unionpayPm });
    apiClient.get = vi.fn().mockResolvedValue({ success: true, data: activatedPm });
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--format', 'json', 'payment-methods', 'add',
      '--payment-brand', 'unionpay',
      '--member', 'mem_789',
      '--api-key', 'sk_key',
      '--email', 'user@example.com',
    ]);

    // In json mode, two JSON objects are emitted: created PM then activated PM.
    // We want the last complete JSON object (the activated one).
    const rawOutput = out.text().trim();
    // Split on `}\n{` boundary to separate multiple JSON objects
    const jsonObjects = rawOutput.split(/\}\s*\n\s*\{/).map((s, i, arr) => {
      if (arr.length === 1) return s;
      if (i === 0) return s + '}';
      if (i === arr.length - 1) return '{' + s;
      return '{' + s + '}';
    });
    const parsed = JSON.parse(jsonObjects[jsonObjects.length - 1]) as Record<string, unknown>;
    expect(parsed.id).toBe('pm_upi_3');
    expect(parsed.status).toBe('ACTIVE');
  });

  it('propagates upstream failure via CliError.fromApi (e.g. missing member_id server-side)', async () => {
    const apiClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 400,
        data: null,
      }),
    };
    const program = buildProgram();
    const cmd = program.command('payment-methods');
    registerAddCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'payment-methods', 'add',
        '--payment-brand', 'unionpay',
        '--member', 'mem_err',
        '--api-key', 'sk_key',
        '--email', 'user@example.com',
      ]),
    ).rejects.toBeInstanceOf(CliError);
  });
});

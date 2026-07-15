import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerCreateCommand } from '../../src/developers/create.js';
import { registerListCommand } from '../../src/developers/list.js';
import { registerGetCommand } from '../../src/developers/get.js';
import { registerUpdateCommand } from '../../src/developers/update.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, mockAuthService, mockConfigManager, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

const BANK_ACCOUNT_FLAGS = [
  '--bank-beneficiary-name', 'Bot Inc',
  '--bank-account-number', '1234567890123456',
  '--bank-name', 'Test Bank',
  '--bank-country', 'US',
  '--bank-swift-code', 'TESTUS33',
];

const BANK_ACCOUNT_VIEW = { beneficiary_name: 'Bot Inc', account_number: '************3456', bank_name: 'Test Bank', bank_country: 'US', swift_code: 'TESTUS33' };

const DEV = { id: 'dev_001', organization_id: 'org_001', name: 'bot', email: 'bot@a.com', status: 'ACTIVE', billing_mode: 'pay_per_call', bank_account: BANK_ACCOUNT_VIEW, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

function setupCreate(resp?: unknown) {
  const apiClient = mockApiClient({ '/developers/create': resp ?? DEV });
  const authService = mockAuthService(apiClient);
  const configManager = mockConfigManager();
  const program = buildProgram();
  const cmd = program.command('developers');
  registerCreateCommand(cmd, { apiClient, authService, configManager } as any);
  return { program, apiClient };
}

describe('developers create', () => {
  it('creates developer with billing_mode=pay_per_call by default', async () => {
    const { program, apiClient } = setupCreate();
    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'developers', 'create', '--developer-name', 'bot', '--developer-email', 'bot@a.com', ...BANK_ACCOUNT_FLAGS, '--idempotency-key', 'k1']);
    } finally { delete process.env.AGENZO_FORMAT; }
    const call = apiClient.post.mock.calls[0];
    expect(call[2]).toMatchObject({ name: 'bot', email: 'bot@a.com', billing_mode: 'pay_per_call' });
    expect(call[2].bank_account).toMatchObject({ beneficiary_name: 'Bot Inc', account_number: '1234567890123456', bank_name: 'Test Bank', bank_country: 'US', swift_code: 'TESTUS33' });
    const json = parseJsonOutput(out.text()) as any;
    expect(json.id).toBe('dev_001');
    expect(json.billing_mode).toBe('pay_per_call');
  });

  it('sends billing_mode=monthly_settlement when specified', async () => {
    const msdev = { ...DEV, billing_mode: 'monthly_settlement' };
    const { program, apiClient } = setupCreate(msdev);
    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'developers', 'create', '--developer-name', 'ms', '--developer-email', 'ms@a.com', '--billing-mode', 'monthly_settlement', ...BANK_ACCOUNT_FLAGS, '--idempotency-key', 'k2']);
    } finally { delete process.env.AGENZO_FORMAT; }
    expect(apiClient.post.mock.calls[0][2].billing_mode).toBe('monthly_settlement');
    const json = parseJsonOutput(out.text()) as any;
    expect(json.billing_mode).toBe('monthly_settlement');
  });

  it('rejects invalid billing_mode locally (no network call)', async () => {
    const { program, apiClient } = setupCreate();
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'developers', 'create', '--developer-name', 'x', '--developer-email', 'x@x.com', '--billing-mode', 'weekly', ...BANK_ACCOUNT_FLAGS, '--idempotency-key', 'k3'])).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const { program, apiClient } = setupCreate();
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'developers', 'create', '--developer-name', 'x', '--developer-email', 'x@x.com', ...BANK_ACCOUNT_FLAGS])).rejects.toThrow('--idempotency-key');
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('requires bank account flags in --yes mode (bank account mandatory regardless of billing_mode)', async () => {
    const { program, apiClient } = setupCreate();
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'developers', 'create', '--developer-name', 'x', '--developer-email', 'x@x.com', '--idempotency-key', 'k4'])).rejects.toThrow('--bank-beneficiary-name');
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('developers list', () => {
  it('returns array of developers', async () => {
    const apiClient = mockApiClient({ '/developers': [DEV] });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerListCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'developers', 'list']);
    } finally { delete process.env.AGENZO_FORMAT; }
    const json = parseJsonOutput(out.text()) as any;
    expect(json.developers).toHaveLength(1);
    expect(json.developers[0].id).toBe('dev_001');
    expect(json.page).toEqual({ next_cursor: null, has_more: false });
  });
});

describe('developers get', () => {
  it('returns developer by ID', async () => {
    const apiClient = mockApiClient({ '/developers/dev_001': DEV });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerGetCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'developers', 'get', 'dev_001']);
    } finally { delete process.env.AGENZO_FORMAT; }
    const json = parseJsonOutput(out.text()) as any;
    expect(json.id).toBe('dev_001');
    expect(json.billing_mode).toBe('pay_per_call');
  });

  it('throws on 404', async () => {
    const apiClient = { get: vi.fn().mockResolvedValue({ success: false, errorCode: 1201, errorMessage: 'Not found', statusCode: 404 }) };
    const authService = { executeWithAuth: vi.fn((fn) => fn('t')) };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerGetCommand(cmd, { apiClient, authService, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'developers', 'get', 'dev_nope'])).rejects.toThrow();
  });
});

describe('developers update', () => {
  it('replaces bank account wholesale when --bank-* flags are supplied', async () => {
    const updated = { ...DEV, bank_account: { ...BANK_ACCOUNT_VIEW, account_number: '************6666' } };
    const apiClient = mockApiClient({ '/developers/dev_001/update': updated });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerUpdateCommand(cmd, { apiClient, authService, configManager } as any);

    captureStdout(); captureStderr();
    await program.parseAsync(['node', 'cli', 'developers', 'update', 'dev_001', '--bank-beneficiary-name', 'Bot Inc', '--bank-account-number', '9999888877776666', '--bank-name', 'Test Bank', '--bank-country', 'US', '--bank-swift-code', 'TESTUS33', '--idempotency-key', 'k9']);
    const call = apiClient.post.mock.calls[0];
    expect(call[2].bank_account).toMatchObject({ account_number: '9999888877776666' });
  });

  it('does not send bank_account when no --bank-* flags are supplied', async () => {
    const updated = { ...DEV, name: 'bot-prod' };
    const apiClient = mockApiClient({ '/developers/dev_001/update': updated });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerUpdateCommand(cmd, { apiClient, authService, configManager } as any);

    captureStdout(); captureStderr();
    await program.parseAsync(['node', 'cli', 'developers', 'update', 'dev_001', '--name', 'bot-prod', '--idempotency-key', 'k10']);
    const call = apiClient.post.mock.calls[0];
    expect(call[2].bank_account).toBeUndefined();
  });

  it('updates developer name', async () => {
    const updated = { ...DEV, name: 'bot-prod' };
    const apiClient = mockApiClient({ '/developers/dev_001/update': updated });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerUpdateCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'developers', 'update', 'dev_001', '--name', 'bot-prod', '--idempotency-key', 'k1']);
    } finally { delete process.env.AGENZO_FORMAT; }
    const json = parseJsonOutput(out.text()) as any;
    expect(json.name).toBe('bot-prod');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('developers');
    registerUpdateCommand(cmd, { apiClient, authService, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'developers', 'update', 'dev_001', '--name', 'x'])).rejects.toThrow('--idempotency-key');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerGetCommand } from '../../src/accounts/get.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, mockAuthService, mockConfigManager, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

const ACCOUNT = { id: 'acct_001', developer_id: 'dev_001', balance: '0', currency: 'USD', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

describe('accounts get', () => {
  it('returns settlement account when it exists', async () => {
    const apiClient = mockApiClient({ '/accounts': ACCOUNT });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('accounts');
    registerGetCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'accounts', 'get', '--developer-id', 'dev_001']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.id).toBe('acct_001');
    expect(json.currency).toBe('USD');
    expect(json.status).toBe('active');
  });

  it('returns null when no account exists (pay_per_call dev)', async () => {
    const apiClient = mockApiClient({ '/accounts': null });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('accounts');
    registerGetCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'accounts', 'get', '--developer-id', 'dev_002']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.account).toBeNull();
  });

  it('throws on 404 (developer not found)', async () => {
    const apiClient = { get: vi.fn().mockResolvedValue({ success: false, errorCode: 1201, errorMessage: 'Not found', statusCode: 404 }) };
    const authService = { executeWithAuth: vi.fn((fn) => fn('t')) };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('accounts');
    registerGetCommand(cmd, { apiClient, authService, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'accounts', 'get', '--developer-id', 'dev_nope'])).rejects.toThrow();
  });
});

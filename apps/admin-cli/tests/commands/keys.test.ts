import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerCreateCommand } from '../../src/keys/create.js';
import { registerListCommand } from '../../src/keys/list.js';
import { registerGetCommand } from '../../src/keys/get.js';
import { registerRotateCommand } from '../../src/keys/rotate.js';
import { registerDisableCommand } from '../../src/keys/disable.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, mockAuthService, mockConfigManager, mockKeyStore, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

const KEY = { id: 'key_001', developer_id: 'dev_001', name: 'Prod Key', api_key: 'sk_test_abc123', key_prefix: 'sk_test_', scope: ['token', 'merchant', 'payment'], status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z', last_used_at: null };

describe('keys create', () => {
  it('creates key with scope and returns api_key', async () => {
    const apiClient = mockApiClient({ '/keys/create': KEY });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const keyStore = mockKeyStore();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerCreateCommand(cmd, { apiClient, authService, configManager, keyStore } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'keys', 'create', '--developer-id', 'dev_001', '--key-name', 'Prod Key', '--scope', 'token,merchant', '--idempotency-key', 'k1']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.api_key).toBe('sk_test_abc123');
    expect(json.scope).toEqual(['token', 'merchant', 'payment']);
    expect(keyStore.add).toHaveBeenCalled();
  });

  it('rejects invalid scope locally', async () => {
    const apiClient = mockApiClient();
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const keyStore = mockKeyStore();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerCreateCommand(cmd, { apiClient, authService, configManager, keyStore } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'keys', 'create', '--developer-id', 'x', '--key-name', 'x', '--scope', 'invalid', '--idempotency-key', 'k'])).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const keyStore = mockKeyStore();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerCreateCommand(cmd, { apiClient, authService, configManager, keyStore } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'keys', 'create', '--developer-id', 'x', '--key-name', 'x'])).rejects.toThrow('--idempotency-key');
  });
});

describe('keys list', () => {
  it('returns keys without api_key plaintext', async () => {
    const keys = [{ ...KEY, api_key: 'sk_test_should_be_stripped' }];
    const apiClient = mockApiClient({ '/keys': keys });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerListCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'keys', 'list', '--developer-id', 'dev_001']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.keys[0]).not.toHaveProperty('api_key');
    expect(json.keys[0].scope).toEqual(['token', 'merchant', 'payment']);
    expect(json.page).toEqual({ next_cursor: null, has_more: false });
  });
});

describe('keys get', () => {
  it('returns key metadata without api_key', async () => {
    const apiClient = mockApiClient({ '/keys/key_001': KEY });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerGetCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'keys', 'get', 'key_001']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json).not.toHaveProperty('api_key');
    expect(json.id).toBe('key_001');
    expect(json.scope).toEqual(['token', 'merchant', 'payment']);
  });
});

describe('keys rotate', () => {
  it('returns new api_key and updates keyStore', async () => {
    const rotated = { ...KEY, api_key: 'sk_test_new_rotated' };
    const apiClient = mockApiClient({ '/keys/key_001/rotate': rotated });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const keyStore = mockKeyStore();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerRotateCommand(cmd, { apiClient, authService, keyStore, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'keys', 'rotate', 'key_001', '--idempotency-key', 'r1']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.api_key).toBe('sk_test_new_rotated');
    expect(keyStore.update).toHaveBeenCalledWith('org_test_001', 'key_001', 'sk_test_new_rotated');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const keyStore = mockKeyStore();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerRotateCommand(cmd, { apiClient, authService, keyStore, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'keys', 'rotate', 'key_001'])).rejects.toThrow('--idempotency-key');
  });
});

describe('keys disable', () => {
  it('disables key and returns status', async () => {
    const apiClient = mockApiClient({ '/keys/key_001/disable': { status: 'DISABLED' } });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerDisableCommand(cmd, { apiClient, authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'keys', 'disable', 'key_001', '--idempotency-key', 'd1']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.status).toBe('DISABLED');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const cmd = program.command('keys');
    registerDisableCommand(cmd, { apiClient, authService, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'keys', 'disable', 'key_001'])).rejects.toThrow('--idempotency-key');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerCreateCommand } from '../../src/developers/create.js';
import { registerListCommand } from '../../src/developers/list.js';
import { registerGetCommand } from '../../src/developers/get.js';
import { registerUpdateCommand } from '../../src/developers/update.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, mockAuthService, mockConfigManager, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

const DEV = { id: 'dev_001', organization_id: 'org_001', name: 'bot', email: 'bot@a.com', status: 'ACTIVE', billing_mode: 'pay_per_call', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

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
      await program.parseAsync(['node', 'cli', 'developers', 'create', '--developer-name', 'bot', '--developer-email', 'bot@a.com', '--idempotency-key', 'k1']);
    } finally { delete process.env.AGENZO_FORMAT; }
    const call = apiClient.post.mock.calls[0];
    expect(call[2]).toMatchObject({ name: 'bot', email: 'bot@a.com', billing_mode: 'pay_per_call' });
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
      await program.parseAsync(['node', 'cli', 'developers', 'create', '--developer-name', 'ms', '--developer-email', 'ms@a.com', '--billing-mode', 'monthly_settlement', '--idempotency-key', 'k2']);
    } finally { delete process.env.AGENZO_FORMAT; }
    expect(apiClient.post.mock.calls[0][2].billing_mode).toBe('monthly_settlement');
    const json = parseJsonOutput(out.text()) as any;
    expect(json.billing_mode).toBe('monthly_settlement');
  });

  it('rejects invalid billing_mode locally (no network call)', async () => {
    const { program, apiClient } = setupCreate();
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'developers', 'create', '--developer-name', 'x', '--developer-email', 'x@x.com', '--billing-mode', 'weekly', '--idempotency-key', 'k3'])).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const { program, apiClient } = setupCreate();
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'developers', 'create', '--developer-name', 'x', '--developer-email', 'x@x.com'])).rejects.toThrow('--idempotency-key');
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

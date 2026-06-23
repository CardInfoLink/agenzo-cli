import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerMeCommand } from '../../src/orgs/get.js';
import { registerUpdateCommand } from '../../src/orgs/update.js';
import { registerListCommand } from '../../src/orgs/list.js';
import { registerSwitchCommand } from '../../src/orgs/switch.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient, mockAuthService, mockConfigManager, mockCredentialStore, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

const ORG = { id: 'org_001', name: 'Acme', email: 'a@b.com', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

describe('orgs get', () => {
  it('returns Organization JSON on success', async () => {
    const apiClient = mockApiClient({ '/organizations/me': ORG });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerMeCommand(orgsCmd, { apiClient, authService, configManager } as any);

    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'orgs', 'get']);
    } finally { delete process.env.AGENZO_FORMAT; }

    expect(apiClient.get).toHaveBeenCalledWith('/organizations/me', { type: 'bearer', token: 'fake_bearer_token' });
    const json = parseJsonOutput(out.text()) as any;
    expect(json.id).toBe('org_001');
    expect(json.name).toBe('Acme');
  });

  it('throws on API failure (triggers exit 1)', async () => {
    const apiClient = { get: vi.fn().mockResolvedValue({ success: false, errorCode: 1201, errorMessage: 'Not found', statusCode: 404 }) };
    const authService = { executeWithAuth: vi.fn((fn) => fn('t')) };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerMeCommand(orgsCmd, { apiClient, authService, configManager } as any);

    captureStdout();
    captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'orgs', 'get'])).rejects.toThrow();
  });
});

describe('orgs update', () => {
  it('updates name and returns Organization', async () => {
    const updated = { ...ORG, name: 'Acme Inc.' };
    const apiClient = mockApiClient({ '/organizations/me/update': updated });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore([{ org_id: 'org_001', org_name: 'Acme', email: 'a@b.com', api_host: 'https://agent.everonet.com' }]);
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerUpdateCommand(orgsCmd, { apiClient, authService, configManager, credentialStore } as any);

    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'orgs', 'update', '--name', 'Acme Inc.', '--idempotency-key', 'k1']);
    } finally { delete process.env.AGENZO_FORMAT; }

    expect(apiClient.post).toHaveBeenCalled();
    const json = parseJsonOutput(out.text()) as any;
    expect(json.name).toBe('Acme Inc.');
  });

  it('email change returns pending-verification WITHOUT exposing the magic link token', async () => {
    const verifyResp = { magic_link_token: 'mlt_xxx', expires_at: '2026-06-04T10:00:00Z' };
    const apiClient = mockApiClient({ '/organizations/me/update': verifyResp });
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore();
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerUpdateCommand(orgsCmd, { apiClient, authService, configManager, credentialStore } as any);

    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'orgs', 'update', '--email', 'new@b.com', '--idempotency-key', 'k2']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const raw = out.text();
    // The consumable token must never reach stdout.
    expect(raw).not.toContain('mlt_xxx');
    const json = parseJsonOutput(raw) as any;
    expect(json).not.toHaveProperty('magic_link_token');
    expect(json).not.toHaveProperty('id');
    expect(json.status).toBe('PENDING_EMAIL_VERIFICATION');
    expect(json.expires_at).toBe('2026-06-04T10:00:00Z');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const authService = mockAuthService(apiClient);
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore();
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerUpdateCommand(orgsCmd, { apiClient, authService, configManager, credentialStore } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'orgs', 'update', '--name', 'X'])).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('orgs list', () => {
  it('returns filtered credentials as array', async () => {
    const creds = [
      { org_id: 'org_1', org_name: 'Org1', email: 'a@a.com', api_host: 'https://agent.everonet.com' },
      { org_id: 'org_2', org_name: 'Org2', email: 'b@b.com', api_host: 'https://other.com' },
    ];
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore(creds);
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerListCommand(orgsCmd, { credentialStore, configManager } as any);

    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'orgs', 'list']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    // Only org_1 matches the current host
    expect(json.organizations).toHaveLength(1);
    expect(json.organizations[0].org_id).toBe('org_1');
    expect(json.page).toEqual({ next_cursor: null, has_more: false });
  });
});

describe('orgs switch', () => {
  it('switches to a valid local org', async () => {
    const creds = [{ org_id: 'org_1', org_name: 'Org1', email: 'a@a.com', api_host: 'https://agent.everonet.com' }];
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore(creds);
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerSwitchCommand(orgsCmd, { credentialStore, configManager } as any);

    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'orgs', 'switch', 'org_1']);
    } finally { delete process.env.AGENZO_FORMAT; }

    expect(configManager.setActiveOrg).toHaveBeenCalledWith('org_1');
    const json = parseJsonOutput(out.text()) as any;
    expect(json.active_org).toBe('org_1');
  });

  it('rejects switch to non-existent org', async () => {
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore([]);
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerSwitchCommand(orgsCmd, { credentialStore, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'orgs', 'switch', 'org_nope'])).rejects.toThrow('not signed in locally');
  });

  it('rejects switch to org on different host', async () => {
    const creds = [{ org_id: 'org_other', org_name: 'Other', email: 'x@x.com', api_host: 'https://other.com' }];
    const configManager = mockConfigManager();
    const credentialStore = mockCredentialStore(creds);
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerSwitchCommand(orgsCmd, { credentialStore, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'orgs', 'switch', 'org_other'])).rejects.toThrow('different environment');
  });
});

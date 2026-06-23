import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerLoginCommand } from '../../src/auth/login.js';
import { registerLogoutCommand } from '../../src/auth/logout.js';
import { buildProgram, captureStdout, captureStderr, mockConfigManager, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('auth login', () => {
  it('calls authService.login with email and idempotency key, outputs org info (no tokens)', async () => {
    const credential = { org_id: 'org_001', org_name: 'Acme', email: 'a@b.com' };
    const authService = {
      login: vi.fn().mockResolvedValue({ credential, isNewRegistration: false }),
    };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const authCmd = program.command('auth');
    registerLoginCommand(authCmd, { authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'auth', 'login', '--email', 'a@b.com', '--idempotency-key', 'login-k1']);
    } finally { delete process.env.AGENZO_FORMAT; }

    expect(authService.login).toHaveBeenCalledWith('a@b.com', { idempotencyKey: 'login-k1', quiet: true });
    const json = parseJsonOutput(out.text()) as any;
    expect(json.organization_id).toBe('org_001');
    expect(json.organization).toEqual({ id: 'org_001', name: 'Acme' });
    expect(json.email).toBe('a@b.com');
    // Tokens must NOT appear in stdout
    const raw = out.text();
    expect(raw).not.toContain('access_token');
    expect(raw).not.toContain('refresh_token');
  });

  it('reports new registration via stderr status (not stdout payload)', async () => {
    const credential = { org_id: 'org_new', org_name: 'NewOrg', email: 'new@x.com' };
    const authService = {
      login: vi.fn().mockResolvedValue({ credential, isNewRegistration: true }),
    };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const authCmd = program.command('auth');
    registerLoginCommand(authCmd, { authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'auth', 'login', '--email', 'new@x.com', '--idempotency-key', 'login-k2']);
    } finally { delete process.env.AGENZO_FORMAT; }

    const json = parseJsonOutput(out.text()) as any;
    expect(json.organization_id).toBe('org_new');
    // is_new_registration is NOT part of the stdout payload
    expect(json).not.toHaveProperty('is_new_registration');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const authService = { login: vi.fn() };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const authCmd = program.command('auth');
    registerLoginCommand(authCmd, { authService, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', '--yes', 'auth', 'login', '--email', 'a@b.com'])).rejects.toThrow('--idempotency-key');
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('json mode does not emit status lines to stderr', async () => {
    const credential = { org_id: 'org_001', org_name: 'Acme', email: 'a@b.com' };
    const authService = {
      login: vi.fn().mockResolvedValue({ credential, isNewRegistration: false }),
    };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const authCmd = program.command('auth');
    registerLoginCommand(authCmd, { authService, configManager } as any);

    captureStdout();
    const err = captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'auth', 'login', '--email', 'a@b.com', '--idempotency-key', 'k']);
    } finally { delete process.env.AGENZO_FORMAT; }

    // json mode should have no status icons in stderr
    expect(err.text()).not.toContain('✓');
    expect(err.text()).not.toContain('ℹ');
  });
});

describe('auth logout', () => {
  it('calls authService.logout and returns signed_out=true', async () => {
    const authService = { logout: vi.fn().mockResolvedValue(undefined) };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const authCmd = program.command('auth');
    registerLogoutCommand(authCmd, { authService, configManager } as any);

    const out = captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'auth', 'logout']);
    } finally { delete process.env.AGENZO_FORMAT; }

    expect(authService.logout).toHaveBeenCalled();
    const json = parseJsonOutput(out.text()) as any;
    expect(json.signed_out).toBe(true);
  });

  it('throws when not signed in', async () => {
    const { AuthError } = await import('@agenzo/cli-core');
    const authService = {
      logout: vi.fn().mockRejectedValue(new AuthError('Not signed in', 'run login')),
    };
    const configManager = mockConfigManager();
    const program = buildProgram();
    const authCmd = program.command('auth');
    registerLogoutCommand(authCmd, { authService, configManager } as any);
    captureStdout(); captureStderr();
    await expect(program.parseAsync(['node', 'cli', 'auth', 'logout'])).rejects.toThrow('Not signed in');
  });
});

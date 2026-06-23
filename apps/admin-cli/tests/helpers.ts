/**
 * Shared test helpers for admin-cli command integration tests.
 * Provides mock deps, stdout/stderr capture, and command execution utilities.
 */
import { vi } from 'vitest';
import { Command } from 'commander';

/** Capture process.stdout.write calls and return joined text. */
export function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
  return { spy, text: () => chunks.join('') };
}

/** Capture console.error (stderr) calls. */
export function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  return { spy, text: () => chunks.join('\n') };
}

/** Build a root Command with global flags matching index.ts wiring. */
export function buildProgram(): Command {
  const root = new Command();
  root.exitOverride();
  root.option('--format <format>');
  root.option('--yes');
  root.option('--verbose');
  return root;
}

/** Create a mock ApiClient that returns a success response. */
export function mockApiClient(responses?: Record<string, unknown>) {
  const defaultResp = { success: true, data: {} };
  return {
    get: vi.fn().mockImplementation((path: string) => {
      if (responses && path in responses) {
        return Promise.resolve({ success: true, data: responses[path] });
      }
      return Promise.resolve(defaultResp);
    }),
    post: vi.fn().mockImplementation((path: string) => {
      if (responses && path in responses) {
        return Promise.resolve({ success: true, data: responses[path] });
      }
      return Promise.resolve(defaultResp);
    }),
  };
}

/** Create a mock AuthService that passes through to apiClient calls. */
export function mockAuthService(apiClient: ReturnType<typeof mockApiClient>) {
  return {
    executeWithAuth: vi.fn((fn) => fn('fake_bearer_token')),
    login: vi.fn(),
    logout: vi.fn(),
    getValidAccessToken: vi.fn().mockResolvedValue('fake_bearer_token'),
  };
}

/** Create a mock ConfigManager. */
export function mockConfigManager(overrides?: Partial<{ api_host: string; api_path: string; active_org: string | null }>) {
  const config = {
    api_host: 'https://agent.everonet.com',
    api_path: '/api/admin/v1',
    active_org: 'org_test_001',
    active_developer_id: null,
    ...overrides,
  };
  return {
    load: vi.fn().mockResolvedValue({ ...config }),
    save: vi.fn(),
    getActiveOrg: vi.fn().mockResolvedValue(config.active_org),
    setActiveOrg: vi.fn(),
    getApiHost: vi.fn().mockResolvedValue(config.api_host),
    setApiHost: vi.fn(),
    getApiPath: vi.fn().mockReturnValue(config.api_path),
    getApiBaseUrl: vi.fn().mockResolvedValue(`${config.api_host}${config.api_path}`),
    ensureDirectories: vi.fn(),
  };
}

/** Create a mock CredentialStore. */
export function mockCredentialStore(credentials: Array<{ org_id: string; org_name: string; email: string; api_host: string }> = []) {
  return {
    get: vi.fn((orgId: string) => {
      const found = credentials.find((c) => c.org_id === orgId);
      return Promise.resolve(found ? { ...found, access_token: 'at', refresh_token: 'rt', access_token_expires_at: 9999999999, refresh_token_expires_at: 9999999999 } : null);
    }),
    save: vi.fn(),
    delete: vi.fn(),
    listAll: vi.fn().mockResolvedValue(credentials.map((c) => ({ ...c, access_token: 'at', refresh_token: 'rt', access_token_expires_at: 9999999999, refresh_token_expires_at: 9999999999 }))),
    exists: vi.fn((orgId: string) => Promise.resolve(credentials.some((c) => c.org_id === orgId))),
  };
}

/** Create a mock KeyStore. */
export function mockKeyStore() {
  return {
    add: vi.fn(),
    update: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  };
}

/** Parse stdout JSON output (strips trailing newline). */
export function parseJsonOutput(raw: string): unknown {
  return JSON.parse(raw.trim());
}

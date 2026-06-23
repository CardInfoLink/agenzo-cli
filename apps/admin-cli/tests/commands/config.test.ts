import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerConfigCommand } from '../../src/config/set.js';
import { buildProgram, captureStdout, captureStderr, mockConfigManager, mockCredentialStore, parseJsonOutput } from '../helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

function setup(opts?: { credentials?: Array<{ org_id: string; org_name: string; email: string; api_host: string }> }) {
  const configManager = mockConfigManager();
  const credentialStore = mockCredentialStore(opts?.credentials ?? []);
  const program = buildProgram();
  registerConfigCommand(program, { configManager, credentialStore } as any);
  return { program, configManager, credentialStore };
}

describe('config set-host', () => {
  it('sets host and clears active_org when no credential matches', async () => {
    const { program, configManager } = setup();
    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'config', 'set-host', 'https://new-host.com']);
    } finally { delete process.env.AGENZO_FORMAT; }
    expect(configManager.setApiHost).toHaveBeenCalledWith('https://new-host.com');
    const json = parseJsonOutput(out.text()) as any;
    expect(json.api_host).toBe('https://new-host.com');
    expect(json.active_org).toBeNull();
  });

  it('auto-switches org when credential matches host', async () => {
    const creds = [{ org_id: 'org_match', org_name: 'Match', email: 'a@b.com', api_host: 'https://match.com' }];
    const { program, configManager } = setup({ credentials: creds });
    captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'config', 'set-host', 'https://match.com']);
    } finally { delete process.env.AGENZO_FORMAT; }
    expect(configManager.setActiveOrg).toHaveBeenCalledWith('org_match');
  });

  it('rejects non-local HTTP hosts before writing config', async () => {
    const { program, configManager } = setup();
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'config', 'set-host', 'http://example.com']),
    ).rejects.toThrow('Insecure API host');

    expect(configManager.setApiHost).not.toHaveBeenCalled();
  });
});

describe('config show', () => {
  it('returns current config as JSON', async () => {
    const { program } = setup();
    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'config', 'show']);
    } finally { delete process.env.AGENZO_FORMAT; }
    const json = parseJsonOutput(out.text()) as any;
    expect(json.api_host).toBe('https://agent.everonet.com');
    expect(json.api_path).toBe('/api/admin/v1');
    expect(json.active_org).toBe('org_test_001');
  });
});

describe('config reset-host', () => {
  it('resets to default production host', async () => {
    const { program, configManager } = setup();
    const out = captureStdout();
    captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await program.parseAsync(['node', 'cli', 'config', 'reset-host']);
    } finally { delete process.env.AGENZO_FORMAT; }
    expect(configManager.setApiHost).toHaveBeenCalledWith('https://agent.everonet.com');
    const json = parseJsonOutput(out.text()) as any;
    expect(json.api_host).toBe('https://agent.everonet.com');
  });
});

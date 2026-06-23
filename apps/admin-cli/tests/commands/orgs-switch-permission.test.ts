import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, CredentialStore, type OrgCredential } from '@agenzo/cli-core';
import { AuthService } from '../../src/auth/auth-service.js';
import { registerSwitchCommand } from '../../src/orgs/switch.js';
import { buildProgram, captureStdout, captureStderr } from '../helpers.js';

/**
 * Permission-mixup (credential bleed) protection test.
 *
 * Using real ConfigManager + CredentialStore + AuthService (temp directory, no mocks),
 * verify that after `orgs switch` changes active_org, the Bearer token resolved by subsequent auth commands
 * is indeed [the new org's], not the org's from before the switch — this is switch's most core security invariant.
 *
 * Also verify that after a cross-environment / nonexistent org is rejected, active_org is not polluted.
 */

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const HOST = 'https://agent.everonet.com';
const OTHER_HOST = 'https://agent-test.everonet.com';

function cred(orgId: string, token: string, apiHost: string): OrgCredential {
  return {
    org_id: orgId,
    org_name: `Org ${orgId}`,
    email: `${orgId}@acme.com`,
    access_token: token,
    refresh_token: `refresh_${token}`,
    access_token_expires_at: FAR_FUTURE,
    refresh_token_expires_at: FAR_FUTURE,
    api_host: apiHost,
  };
}

/** apiClient stub that fails the test if any network call is attempted. */
function noNetworkApiClient() {
  return {
    get: vi.fn(() => { throw new Error('unexpected network call'); }),
    post: vi.fn(() => { throw new Error('unexpected network call'); }),
  } as any;
}

describe('orgs switch — permission/credential isolation', () => {
  let dir: string;
  let configManager: ConfigManager;
  let credentialStore: CredentialStore;
  let authService: AuthService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agenzo-switch-perm-'));
    configManager = new ConfigManager(dir);
    credentialStore = new CredentialStore(join(dir, 'credentials'));
    authService = new AuthService(noNetworkApiClient(), credentialStore, configManager);
    await configManager.ensureDirectories();
    await configManager.setApiHost(HOST);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function runSwitch(orgId: string): Promise<void> {
    const program = buildProgram();
    const orgsCmd = program.command('orgs');
    registerSwitchCommand(orgsCmd, { credentialStore, configManager });
    await program.parseAsync(['node', 'cli', 'orgs', 'switch', orgId]);
  }

  it('after switch, auth resolves to the token for the NEW org, not the old one (no credential bleed)', async () => {
    await credentialStore.save(cred('org_A', 'tokenA', HOST));
    await credentialStore.save(cred('org_B', 'tokenB', HOST));
    await configManager.setActiveOrg('org_A');

    // before switch: resolves to A's token
    expect(await authService.getValidAccessToken()).toBe('tokenA');

    captureStdout(); captureStderr();
    process.env.AGENZO_FORMAT = 'json';
    try {
      await runSwitch('org_B');
    } finally { delete process.env.AGENZO_FORMAT; }

    // after switch: must resolve to B's token, never still A's
    expect(await configManager.getActiveOrg()).toBe('org_B');
    const tokenAfter = await authService.getValidAccessToken();
    expect(tokenAfter).toBe('tokenB');
    expect(tokenAfter).not.toBe('tokenA');
  });

  it('switching back and forth A→B→A resolves to the matching org token each time', async () => {
    await credentialStore.save(cred('org_A', 'tokenA', HOST));
    await credentialStore.save(cred('org_B', 'tokenB', HOST));
    await configManager.setActiveOrg('org_A');

    captureStdout(); captureStderr();
    await runSwitch('org_B');
    expect(await authService.getValidAccessToken()).toBe('tokenB');

    await runSwitch('org_A');
    expect(await authService.getValidAccessToken()).toBe('tokenA');
  });

  it('cross-environment switch is rejected, active_org not polluted (still points to the original org, token unchanged)', async () => {
    await credentialStore.save(cred('org_A', 'tokenA', HOST));
    await credentialStore.save(cred('org_X', 'tokenX', OTHER_HOST)); // different host
    await configManager.setActiveOrg('org_A');

    captureStdout(); captureStderr();
    await expect(runSwitch('org_X')).rejects.toThrow('different environment');

    // active_org must still be org_A, token still A's, not switched to X
    expect(await configManager.getActiveOrg()).toBe('org_A');
    expect(await authService.getValidAccessToken()).toBe('tokenA');
  });

  it('switching to a not-signed-in org is rejected, active_org not polluted', async () => {
    await credentialStore.save(cred('org_A', 'tokenA', HOST));
    await configManager.setActiveOrg('org_A');

    captureStdout(); captureStderr();
    await expect(runSwitch('org_ghost')).rejects.toThrow('not signed in locally');

    expect(await configManager.getActiveOrg()).toBe('org_A');
    expect(await authService.getValidAccessToken()).toBe('tokenA');
  });

  it('switch triggers no network calls (token not near expiry, purely local operation)', async () => {
    const apiClient = noNetworkApiClient();
    authService = new AuthService(apiClient, credentialStore, configManager);
    await credentialStore.save(cred('org_A', 'tokenA', HOST));
    await credentialStore.save(cred('org_B', 'tokenB', HOST));
    await configManager.setActiveOrg('org_A');

    captureStdout(); captureStderr();
    await runSwitch('org_B');
    await authService.getValidAccessToken();

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

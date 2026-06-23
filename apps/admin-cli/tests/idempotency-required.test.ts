import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerLoginCommand } from '../src/auth/login.js';
import { registerRotateCommand } from '../src/keys/rotate.js';
import { registerDisableCommand } from '../src/keys/disable.js';
import { IdempotencyKeyRequiredError } from '@agenzo/cli-core';

/**
 * §4.6 --idempotency-key policy for server-write commands (Property 6 / Req 4.3, cli-design §1)
 *
 * Policy: --idempotency-key is required for all server-write commands, but the handling when it is missing has two modes:
 *  - Interactive mode (default): when missing, a prompt asks the user to supply it (this test does not exercise the real prompt, which would hang).
 *  - Non-interactive mode (--yes, automation/AI Agent): the prompt would hang, so when missing it throws
 *    IdempotencyKeyRequiredError, and it is thrown before any network call.
 *
 * The CLI never auto-generates a key. These three are consistent with orgs update / developers create/update /
 * keys create behavior, together satisfying "all server-writes must be idempotent".
 */

/** Build a root program (with the global --yes flag) and register one command. */
function programWith(register: (root: Command) => void): Command {
  const root = new Command();
  root.exitOverride(); // throw instead of process.exit on parse errors
  // The real top-level program defines --yes globally; mirror it here so
  // optsWithGlobals().yes is observable by the handlers under test.
  root.option('--yes', 'Skip confirmation prompts (for automation/AI Agents)');
  register(root);
  return root;
}

describe('mandatory --idempotency-key on server-write commands (--yes mode)', () => {
  it('auth login --yes missing --idempotency-key → IdempotencyKeyRequiredError (does not reach authService)', async () => {
    let loginCalled = false;
    const authService = {
      login: async () => {
        loginCalled = true;
        return {} as never;
      },
    };
    const root = programWith((r) =>
      registerLoginCommand(r, { authService: authService as never }),
    );

    await expect(
      root.parseAsync(['node', 'cli', '--yes', 'login', '--email', 'a@b.com']),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);
    expect(loginCalled).toBe(false);
  });

  it('keys rotate --yes missing --idempotency-key → IdempotencyKeyRequiredError (does not reach apiClient)', async () => {
    let postCalled = false;
    const deps = {
      apiClient: {},
      authService: {
        executeWithAuth: async () => {
          postCalled = true;
          return {} as never;
        },
      },
      keyStore: {},
      configManager: {},
    };
    const root = programWith((r) => registerRotateCommand(r, deps as never));

    await expect(
      root.parseAsync(['node', 'cli', '--yes', 'rotate', 'key_x']),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);
    expect(postCalled).toBe(false);
  });

  it('keys disable --yes missing --idempotency-key → IdempotencyKeyRequiredError (does not reach apiClient)', async () => {
    let postCalled = false;
    const deps = {
      apiClient: {},
      authService: {
        executeWithAuth: async () => {
          postCalled = true;
          return {} as never;
        },
      },
    };
    const root = programWith((r) => registerDisableCommand(r, deps as never));

    await expect(
      root.parseAsync(['node', 'cli', '--yes', 'disable', 'key_x']),
    ).rejects.toBeInstanceOf(IdempotencyKeyRequiredError);
    expect(postCalled).toBe(false);
  });

  it('IdempotencyKeyRequiredError message contains the command name and the --idempotency-key hint', () => {
    const e = new IdempotencyKeyRequiredError('keys rotate');
    expect(e.message).toContain('keys rotate');
    expect(e.message).toContain('--idempotency-key');
  });
});

/**
 * Shared test helpers for merchant-cli command integration tests.
 *
 * Mirrors the sibling token-cli / admin-cli `tests/helpers.ts` for 4-CLI
 * consistency on the API Key plane: a mock `ApiClient` that intercepts
 * `get`/`post` and returns preset `{ success, data }` (or `{ success:false, ... }`)
 * responses, stdout/stderr capture, and a root commander program built for real
 * `parseAsync` (commander is NOT mocked).
 *
 * Used by services.test.ts (6.2) and the later ride-elife / cross-cutting /
 * PBT test tasks (6.3–6.5).
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

/**
 * Build a root Command with the global flags matching merchant-cli index.ts
 * wiring (`--format` / `--yes` / `--verbose` / `--api-key`). `exitOverride`
 * makes commander throw (instead of calling process.exit) so parse failures
 * surface as rejected promises in tests.
 *
 * NOTE: unlike production index.ts, `--format` carries no default here, so an
 * omitted `--format` resolves via `resolveFormat(undefined)` (AGENZO_FORMAT
 * else `table`). Pass `--format json` explicitly to exercise json output.
 */
export function buildProgram(): Command {
  const root = new Command();
  root.exitOverride();
  root.option('--format <format>');
  root.option('--yes');
  root.option('--verbose');
  root.option('--api-key <key>');
  return root;
}

/**
 * Create a mock ApiClient that returns preset responses keyed by path.
 * Supports both `get` and `post`. If no match is found, returns a default
 * success with empty object data.
 */
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

/** Parse stdout JSON output (strips trailing newline). */
export function parseJsonOutput(raw: string): unknown {
  return JSON.parse(raw.trim());
}

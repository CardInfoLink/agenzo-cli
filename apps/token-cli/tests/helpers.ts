/**
 * Shared test helpers for token-cli command integration tests.
 * Mirrors the admin-cli pattern: mock ApiClient, capture stdout/stderr,
 * build a root program with global flags.
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

/** Build a root Command with global flags matching token-cli index.ts wiring. */
export function buildProgram(): Command {
  const root = new Command();
  root.exitOverride();
  root.option('--format <format>');
  root.option('--yes');
  root.option('--verbose');
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

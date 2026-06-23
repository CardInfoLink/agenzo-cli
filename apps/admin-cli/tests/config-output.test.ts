import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerConfigCommand } from '../src/config/set.js';

/**
 * Regression test: config set-host / reset-host must not print duplicates (GAPA-049)
 *
 * Historical bug: applyHost used both notify()(stderr) + CommandResult.text()(stdout) to output
 * the same status line, so in table mode each line was printed twice (once on stderr, once on stdout).
 *
 * Contract (cli-standard §5.1/§5.2):
 * - status lines (✓ / ℹ) go only to stderr (notify)
 * - stdout carries only the payload projection (API Host / Active Org), with no status icons
 */

const STATUS_ICONS = ['✓', 'ℹ', '⚠', '✗'];

/** Capture stdout(process.stdout.write) and stderr(console.error), returning the concatenated text for each. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  return { stdout: () => out.join(''), stderr: () => err.join('\n') };
}

/** Build a root program with the config command group attached, injecting stub deps. */
function programWith(deps: {
  configManager: unknown;
  credentialStore: unknown;
}): Command {
  const root = new Command();
  root.exitOverride();
  registerConfigCommand(root, deps as never);
  return root;
}

/** Minimal stub: set-host takes the "no matching credential → clear active_org" branch (no dependency on real files). */
function makeDeps(opts: { match?: { org_id: string; org_name: string; api_host: string } } = {}) {
  const saved: Record<string, unknown> = { active_org: 'old', api_host: 'old', api_path: '/p' };
  const configManager = {
    setApiHost: vi.fn(async (h: string) => {
      saved.api_host = h;
    }),
    setActiveOrg: vi.fn(async (id: string) => {
      saved.active_org = id;
    }),
    load: vi.fn(async () => ({ ...saved })),
    save: vi.fn(async (c: Record<string, unknown>) => {
      Object.assign(saved, c);
    }),
  };
  const credentialStore = {
    listAll: vi.fn(async () => (opts.match ? [opts.match] : [])),
  };
  return { configManager, credentialStore };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config set-host / reset-host output is not duplicated (GAPA-049 regression)', () => {
  it('TC-CFG-SET-DEDUP-01: with no matching credential, stdout is payload-only, no status icons', async () => {
    const deps = makeDeps();
    const cap = capture();
    const root = programWith(deps);

    await root.parseAsync(['node', 'cli', 'config', 'set-host', 'http://localhost:8000']);

    const stdout = cap.stdout();
    // stdout is the payload projection
    expect(stdout).toContain('API Host');
    expect(stdout).toContain('Active Org');
    // stdout contains no status icons (✓/ℹ etc. should only be on stderr)
    for (const icon of STATUS_ICONS) {
      expect(stdout).not.toContain(icon);
    }
    // stdout contains no status-line text
    expect(stdout).not.toContain('API host set to');
    expect(stdout).not.toContain('Please run login');
  });

  it('TC-CFG-SET-DEDUP-02: status line appears exactly once on stderr (no duplication)', async () => {
    const deps = makeDeps();
    const cap = capture();
    const root = programWith(deps);

    await root.parseAsync(['node', 'cli', 'config', 'set-host', 'http://localhost:8000']);

    const stderr = cap.stderr();
    // the "API host set to" status line appears exactly once
    const occurrences = stderr.split('API host set to').length - 1;
    expect(occurrences).toBe(1);
  });

  it('TC-CFG-SET-DEDUP-03: when a credential matches, stdout contains active_org but not the Switched status line', async () => {
    const deps = makeDeps({
      match: { org_id: 'org_x', org_name: 'Acme', api_host: 'http://localhost:8000' },
    });
    const cap = capture();
    const root = programWith(deps);

    await root.parseAsync(['node', 'cli', 'config', 'set-host', 'http://localhost:8000']);

    const stdout = cap.stdout();
    expect(stdout).toContain('org_x'); // active_org payload
    expect(stdout).not.toContain('Switched to organization'); // status line is only on stderr
    // the Switched line is on stderr only, and only once
    const stderr = cap.stderr();
    expect(stderr.split('Switched to organization').length - 1).toBe(1);
  });

  it('TC-CFG-SET-DEDUP-04: json mode stdout is valid JSON, stderr silent (notify json does not output)', async () => {
    const deps = makeDeps();
    const cap = capture();
    const root = programWith(deps);
    // `--format` is a global option on the real index.ts; the test does not wire up globals,
    // so it uses AGENZO_FORMAT to drive json (resolveFormat reads that env by default).
    const prev = process.env.AGENZO_FORMAT;
    process.env.AGENZO_FORMAT = 'json';
    try {
      await root.parseAsync(['node', 'cli', 'config', 'set-host', 'http://localhost:8000']);
    } finally {
      if (prev === undefined) delete process.env.AGENZO_FORMAT;
      else process.env.AGENZO_FORMAT = prev;
    }

    const parsed = JSON.parse(cap.stdout());
    expect(parsed).toMatchObject({ api_host: 'http://localhost:8000', active_org: null });
    // json mode notify is silent, no status line
    expect(cap.stderr()).not.toContain('API host set to');
  });

  it('TC-CFG-RST-DEDUP-05: reset-host is likewise not duplicated (shares applyHost)', async () => {
    const deps = makeDeps();
    const cap = capture();
    const root = programWith(deps);

    await root.parseAsync(['node', 'cli', 'config', 'reset-host']);

    const stdout = cap.stdout();
    for (const icon of STATUS_ICONS) {
      expect(stdout).not.toContain(icon);
    }
    expect(stdout).toContain('API Host');
    expect(cap.stderr().split('API host reset to').length - 1).toBe(1);
  });
});

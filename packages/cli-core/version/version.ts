/**
 * CLI version + min-version comparator.
 *
 * The CLI's current version is read from `package.json` at runtime. This is
 * the single source of truth — bumping `package.json` automatically updates
 * what the CLI reports and what it compares against the server-advertised
 * minimum (`X-CLI-Min-Version` response header, driven by
 * `AGENT_PAY_CLI_MIN_VERSION` on the server).
 *
 * Only numeric major.minor.patch segments are compared; pre-release and build
 * metadata suffixes are stripped. This matches our versioning scheme and
 * avoids pulling in `semver` for a single `<` check.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Command the user should run to pick up the latest CLI. */
export const UPGRADE_COMMAND = 'npm install -g agenzo-admin-cli@latest';

/**
 * Hard-coded fallback used only when `package.json` cannot be read at runtime
 * (unusual packaging/bundling edge cases). Keep this in sync with
 * `package.json`'s `version` on every release so the reported version and
 * the User-Agent stay accurate even in the degraded path.
 */
export const FALLBACK_VERSION = '0.1.1';

let cachedVersion: string | null = null;

export function getCurrentVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  // Walk up from the compiled file (dist/index.js) or source layout to find
  // package.json. Both `dist/..` and `src/utils/../..` resolve to the project
  // root, which is where package.json lives in a published npm install.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'package.json'),        // dist/ → project root
    join(here, '..', '..', 'package.json'),  // src/utils/ → project root
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string };
      if (typeof pkg.version === 'string') {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    } catch {
      // try next candidate
    }
  }
  // Degrade gracefully instead of crashing the CLI: if we can't locate
  // package.json at runtime, report the hard-coded fallback. The User-Agent
  // and any min-version comparison will still behave sensibly. We write a
  // one-line warning to stderr so packaging regressions remain visible.
  cachedVersion = FALLBACK_VERSION;
  // eslint-disable-next-line no-console
  console.warn(
    `[agenzo-admin-cli] package.json not found; using fallback version ${FALLBACK_VERSION}`,
  );
  return cachedVersion;
}

/**
 * Returns negative / zero / positive like `Array.sort`, comparing `a` against `b`.
 * Non-numeric segments and suffixes are treated as zero.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const clean = v.trim().replace(/^v/, '').split(/[-+]/)[0];
    const parts = clean.split('.');
    return [
      parseInt(parts[0] ?? '0', 10) || 0,
      parseInt(parts[1] ?? '0', 10) || 0,
      parseInt(parts[2] ?? '0', 10) || 0,
    ];
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

export function isBelow(current: string, minimum: string): boolean {
  return compareVersions(current, minimum) < 0;
}

// Error-code contract check.
//
// agenzo-cli is a TypeScript client of the Agenzo backend and does NOT import
// the backend's internal packages as code. Its only coupling to the backend's
// error layer is the error-code CONTRACT: every backend `error.code` (numeric
// string) the CLI references in its production source MUST exist in the error
// catalog. Codes referenced by the CLI but absent from the catalog are
// "orphan" codes and fail the check.
//
// The catalog is read from the local snapshot at contracts/error-codes.json
// (updated by an explicit PR — see contracts/README.md), so this check never
// reaches out over the network.
//
// Runnable: `node scripts/check-error-codes.mjs` (wired as `npm run
// check:error-codes`). Also importable for unit tests.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const CATALOG_PATH = join(REPO_ROOT, 'contracts', 'error-codes.json');

// Production source roots that may reference backend error codes. Tests, build
// output and dependencies are intentionally excluded: test fixtures use
// synthetic codes (e.g. 5000) that are not part of the contract.
const SOURCE_GLOBS = [
  join(REPO_ROOT, 'packages', 'cli-core'),
  join(REPO_ROOT, 'apps'),
];
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'tests', '.git']);

// The api-client sets `errorCode: 0` as the "no code" sentinel for non-JSON /
// unparseable error responses. 0 is not a catalog code and is not a contract
// reference, so it is excluded from orphan analysis.
const SENTINEL_CODES = new Set(['0']);

// Backend numeric error code reference, e.g. `result.errorCode === 1002` or
// `errorCode !== '1007'`. The `errorCode` field (ApiError.errorCode) holds the
// backend's on-the-wire numeric `error.code`, parsed from the unified envelope.
const ERROR_CODE_REF = /\berrorCode\s*[!=]==?\s*['"]?(\d+)['"]?/g;

// Disallowed backend code imports: the CLI must couple to the backend only
// through the error-code contract, never by importing the backend's internal
// packages as code.
const FORBIDDEN_IMPORT = /\b(?:py[_-]commons|agenzo[_-]py[_-]commons|agenzo_commons)\b/;
const IMPORT_LINE = /^\s*(?:import\b|export\b[^=]*\bfrom\b|.*\brequire\s*\()/;

/** Load the catalog snapshot and return the set of valid numeric code strings. */
export function loadCatalog(catalogPath = CATALOG_PATH) {
  const raw = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(raw.codes)) {
    throw new Error(`Catalog at ${catalogPath} is missing a "codes" array`);
  }
  return new Set(raw.codes.map(String));
}

/** Recursively collect *.ts source files under a root, skipping excluded dirs. */
function collectSourceFiles(root) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    if (EXCLUDED_DIR_NAMES.has(name)) continue;
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Scan the CLI production source for backend `error.code` references.
 * Returns a map: code (string) -> array of "relativePath:line" locations.
 */
export function scanReferencedCodes(roots = SOURCE_GLOBS) {
  /** @type {Map<string, string[]>} */
  const refs = new Map();
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        ERROR_CODE_REF.lastIndex = 0;
        let m;
        while ((m = ERROR_CODE_REF.exec(line)) !== null) {
          const code = m[1];
          if (SENTINEL_CODES.has(code)) continue;
          const loc = `${relative(REPO_ROOT, file)}:${idx + 1}`;
          if (!refs.has(code)) refs.set(code, []);
          refs.get(code).push(loc);
        }
      });
    }
  }
  return refs;
}

/**
 * Scan the CLI source for forbidden backend code imports.
 * Returns an array of "relativePath:line  <line text>" violations.
 */
export function scanForbiddenImports(roots = SOURCE_GLOBS) {
  const violations = [];
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (IMPORT_LINE.test(line) && FORBIDDEN_IMPORT.test(line)) {
          violations.push(`${relative(REPO_ROOT, file)}:${idx + 1}  ${line.trim()}`);
        }
      });
    }
  }
  return violations;
}

/**
 * Run the full contract check. Returns { ok, orphans, referenced, forbidden }.
 * `orphans` is a map of orphan code -> locations.
 */
export function checkContract({ catalogPath = CATALOG_PATH, roots = SOURCE_GLOBS } = {}) {
  const catalog = loadCatalog(catalogPath);
  const referenced = scanReferencedCodes(roots);
  const forbidden = scanForbiddenImports(roots);

  const orphans = new Map();
  for (const [code, locs] of referenced) {
    if (!catalog.has(code)) orphans.set(code, locs);
  }

  return {
    ok: orphans.size === 0 && forbidden.length === 0,
    catalogSize: catalog.size,
    referenced,
    orphans,
    forbidden,
  };
}

function main() {
  let result;
  try {
    result = checkContract();
  } catch (err) {
    console.error(`✗ error-code contract check failed to run: ${err.message}`);
    process.exit(1);
    return;
  }

  const { referenced, orphans, forbidden, catalogSize } = result;

  console.log('Error-code contract check');
  console.log(`  catalog snapshot: contracts/error-codes.json (${catalogSize} codes)`);
  console.log(`  CLI-referenced backend error.codes: ${[...referenced.keys()].sort().join(', ') || '(none)'}`);

  if (forbidden.length > 0) {
    console.error('\n✗ CLI imports backend internal code (forbidden):');
    for (const v of forbidden) console.error(`    ${v}`);
  }

  if (orphans.size > 0) {
    console.error('\n✗ Orphan error codes (referenced by CLI, absent from catalog):');
    for (const [code, locs] of orphans) {
      console.error(`    ${code}  ← ${locs.join(', ')}`);
    }
    console.error('\n  Either the code is wrong in the CLI, or the contract snapshot is stale.');
    console.error('  See contracts/README.md to refresh contracts/error-codes.json via an explicit PR.');
  }

  if (!result.ok) {
    process.exit(1);
    return;
  }

  console.log('\n✓ All CLI-referenced error codes exist in the catalog; no backend internal code imports.');
}

// Run when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}

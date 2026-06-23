// Error-code contract check.
//
// Verifies that every backend error.code the CLI references in production
// source exists in the error-code catalog snapshot (no orphan codes), that the
// CLI imports none of the backend's internal packages, and that the scanner
// itself correctly detects orphans.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs repo tooling module, no type declarations.
import {
  loadCatalog,
  scanReferencedCodes,
  scanForbiddenImports,
  checkContract,
} from '../../../scripts/check-error-codes.mjs';

describe('error-code contract', () => {
  it('every CLI-referenced backend error.code exists in the catalog (no orphans)', () => {
    const result = checkContract();
    const orphanReport = [...result.orphans.entries()]
      .map(([code, locs]) => `${code} (${(locs as string[]).join(', ')})`)
      .join('; ');
    expect(orphanReport, `orphan codes: ${orphanReport}`).toBe('');
    expect(result.ok).toBe(true);
  });

  it('the CLI does not import the backend internal packages', () => {
    expect(scanForbiddenImports()).toEqual([]);
  });

  it('actually scans real references (guards against an empty/tautological check)', () => {
    const referenced = scanReferencedCodes();
    // auth-service.ts references these backend codes today.
    expect([...referenced.keys()].sort()).toEqual(
      expect.arrayContaining(['1002', '1007', '1101', '1103']),
    );
  });

  it('all referenced codes are a subset of the catalog codes', () => {
    const catalog = loadCatalog();
    for (const code of scanReferencedCodes().keys()) {
      expect(catalog.has(code), `referenced code ${code} missing from catalog`).toBe(true);
    }
  });
});

describe('error-code contract scanner', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-contract-'));
    const src = join(dir, 'apps', 'fake-cli', 'src');
    mkdirSync(src, { recursive: true });
    // 1002 is in the catalog, 9999 is an orphan; tests/ fixtures must be ignored.
    writeFileSync(
      join(src, 'good.ts'),
      'if (result.errorCode === 1002) { doThing(); }\n',
    );
    writeFileSync(
      join(src, 'orphan.ts'),
      'if (result.errorCode === 9999) { boom(); }\n',
    );
    const testsDir = join(dir, 'apps', 'fake-cli', 'tests');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(
      join(testsDir, 'fixture.test.ts'),
      'const mock = { errorCode: 5000 };\n', // synthetic fixture, must be ignored
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags an orphan code and reports its location, ignoring tests/', () => {
    const result = checkContract({
      roots: [join(dir, 'apps')],
    });
    expect(result.ok).toBe(false);
    expect([...result.orphans.keys()]).toEqual(['9999']);
    // 5000 lives under tests/ and must not be scanned.
    expect(result.referenced.has('5000')).toBe(false);
    // 1002 is referenced and present in the catalog → not an orphan.
    expect(result.referenced.has('1002')).toBe(true);
    expect(result.orphans.has('1002')).toBe(false);
  });

  it('flags forbidden backend code imports', () => {
    const bad = join(dir, 'apps', 'bad-cli', 'src');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'evil.ts'), "import { ErrorCode } from 'py_commons';\n");
    const violations = scanForbiddenImports([join(dir, 'apps', 'bad-cli')]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('evil.ts');
  });
});

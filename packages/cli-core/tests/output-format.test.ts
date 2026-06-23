import { describe, it, expect } from 'vitest';
import { resolveFormat, type OutputFormat } from '../formatter/output.js';

/**
 * §4.1 resolveFormat — output format resolution
 *
 * **Property 2: format resolution precedence**
 * **Validates: Requirements 4.2**
 *
 * Precedence: `--format` flag > `AGENZO_FORMAT` env > default `table`.
 * Note (aligned with the real implementation): once a flag is provided it is "authoritative" — a provided-but-invalid flag
 * falls back directly to the default `table`, and no longer descends to env.
 */
describe('resolveFormat', () => {
  it('UT-FMT-01: flag takes precedence over env (json over table)', () => {
    expect(resolveFormat('json', 'table')).toBe('json');
  });

  it('UT-FMT-02: flag takes precedence over env (table over json)', () => {
    expect(resolveFormat('table', 'json')).toBe('table');
  });

  it('UT-FMT-03: use env when no flag (json)', () => {
    expect(resolveFormat(undefined, 'json')).toBe('json');
  });

  it('UT-FMT-04: no flag and no env falls back to default table', () => {
    expect(resolveFormat(undefined, undefined)).toBe('table');
  });

  it('UT-FMT-05: invalid flag falls back to default table (flag is authoritative, does not descend to env)', () => {
    expect(resolveFormat('xml')).toBe('table');
    // even if env is valid, an invalid flag still falls back to the default, not env
    expect(resolveFormat('xml', 'json')).toBe('table');
  });

  it('UT-FMT-06: invalid env + no flag falls back to default table', () => {
    expect(resolveFormat(undefined, 'yaml')).toBe('table');
  });

  it('UT-FMT-07: case-sensitive, JSON is treated as invalid → table', () => {
    expect(resolveFormat('JSON')).toBe('table');
    expect(resolveFormat('Table')).toBe('table');
  });

  it('UT-FMT-08: return value is always ∈ {json, table}', () => {
    const inputs: Array<[string | undefined, string | undefined]> = [
      ['json', undefined],
      ['table', undefined],
      ['xml', 'json'],
      [undefined, 'yaml'],
      [undefined, undefined],
      ['', ''],
    ];
    const allowed: OutputFormat[] = ['json', 'table'];
    for (const [flag, env] of inputs) {
      expect(allowed).toContain(resolveFormat(flag, env));
    }
  });

  it('empty-string flag is treated as invalid → table', () => {
    expect(resolveFormat('')).toBe('table');
  });
});

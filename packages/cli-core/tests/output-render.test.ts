import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '../formatter/output.js';
import type { CommandResult } from '../types/commands.js';

/**
 * §4.2 render — central renderer
 *
 * **Property 1: stdout is valid, payload-only JSON in json mode**
 * **Property 5: secrets never appear on stdout**
 * **Validates: Requirements 4.1, 6.1**
 *
 * Capture stdout: spy on process.stdout.write and assert the written content.
 */
function captureStdout(): { spy: ReturnType<typeof vi.spyOn>; output: () => string } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  return { spy, output: () => chunks.join('') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('render', () => {
  it('UT-RND-01: json mode stdout deep-equals data after a JSON.parse round-trip', () => {
    const data = { a: 1, b: 'x', nested: { c: [1, 2, 3] } };
    const result: CommandResult<typeof data> = {
      data,
      text: () => 'HUMAN TEXT SHOULD NOT APPEAR',
    };
    const { output } = captureStdout();
    render(result, { format: 'json' });
    expect(JSON.parse(output())).toEqual(data);
  });

  it('UT-RND-02: json mode stdout contains no human-readable text', () => {
    const result: CommandResult<{ ok: boolean }> = {
      data: { ok: true },
      text: () => '✓ Signed in\n  Org ID  org_123',
    };
    const { output } = captureStdout();
    render(result, { format: 'json' });
    expect(output()).not.toContain('✓');
    expect(output()).not.toContain('Org ID');
  });

  it('UT-RND-03: table mode stdout === result.text()', () => {
    const text = '✓ Done\n  Key  value';
    const result: CommandResult<{ ignored: boolean }> = {
      data: { ignored: true },
      text: () => text,
    };
    const { output } = captureStdout();
    render(result, { format: 'table' });
    // render appends a newline
    expect(output()).toBe(`${text}\n`);
  });

  it("UT-RND-04: keys create's api_key appears in json, but the Bearer token does not", () => {
    const data = {
      id: 'key_123',
      api_key: 'agz_live_sk_8c4f2a1e9d7b6c5e',
      name: 'Production Key',
      status: 'active',
    };
    const result: CommandResult<typeof data> = {
      data,
      text: () => 'shown only once',
    };
    const { output } = captureStdout();
    render(result, { format: 'json' });
    const out = output();
    expect(out).toContain('api_key');
    expect(out).not.toContain('access_token');
    expect(out).not.toContain('refresh_token');
  });

  it('UT-RND-06: note does not go to stdout', () => {
    const result: CommandResult<{ signed_out: boolean }> = {
      data: { signed_out: true },
      text: () => 'bye',
      note: 'Signed out',
    };
    const { output } = captureStdout();
    render(result, { format: 'json' });
    expect(output()).not.toContain('Signed out');
  });

  it('UT-RND-07: when data is an array, stdout is a valid JSON array', () => {
    const data = [
      { org_id: 'org_1', active: true },
      { org_id: 'org_2', active: false },
    ];
    const result: CommandResult<typeof data> = {
      data,
      text: () => 'table view',
    };
    const { output } = captureStdout();
    render(result, { format: 'json' });
    const parsed = JSON.parse(output());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(data);
  });

  it('json output ends with a newline, convenient for piping to jq', () => {
    const result: CommandResult<{ a: number }> = { data: { a: 1 }, text: () => '' };
    const { output } = captureStdout();
    render(result, { format: 'json' });
    expect(output().endsWith('\n')).toBe(true);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { notify } from '@agenzo/cli-core';

/**
 * §4.9 json mode stderr silence (cross-cutting, Req 4.1/4.4)
 *
 * Policy: the central helper `notify(format, type, message)` returns directly in `json` mode
 * (does not write stderr); only in `table` mode does it `console.error(Formatter.status(...))`.
 * This guarantees agent consumers see no status-icon / text noise in json mode.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notify json-quiet behavior', () => {
  it("TC-QUIET-01: notify('json', ...) does not write to stderr", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('json', 'success', 'Operation completed');
    expect(spy).not.toHaveBeenCalled();
  });

  it("TC-QUIET-02: notify('table', ...) writes to stderr once with status icon", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('table', 'success', 'Operation completed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('✓');
    expect(spy.mock.calls[0][0]).toContain('Operation completed');
  });

  it("TC-QUIET-03: notify('json', 'info', ...) is silent", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('json', 'info', 'Some info message');
    expect(spy).not.toHaveBeenCalled();
  });

  it("TC-QUIET-04: notify('table', 'info', ...) writes ℹ to stderr", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('table', 'info', 'Some info message');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('ℹ');
  });

  it("TC-QUIET-05: notify('json', 'warning', ...) is silent", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notify('json', 'warning', 'Watch out');
    expect(spy).not.toHaveBeenCalled();
  });

  it("TC-QUIET-06: all status types are silent in json mode", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const types = ['success', 'error', 'info', 'warning', 'loading'] as const;
    for (const type of types) {
      notify('json', type, `message for ${type}`);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

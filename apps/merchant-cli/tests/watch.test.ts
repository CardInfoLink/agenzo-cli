/**
 * Example-based unit tests for the NDJSON watch engine
 * (`src/ride-elife/watch.ts`) — design Property 2 / Req 3.2.
 *
 * Covers test-design §4.3 (pure helpers: isTerminalStatus / statusOf /
 * resolveSeconds / TERMINAL_STATUSES + default constants) and §4.4
 * (`runWatch` with injected fetchStatus / writeLine / sleep / now via a fake
 * clock: first-poll terminal, multi-poll to terminal, never-terminal timeout,
 * fetchStatus throw propagation, compact single-line NDJSON, timeout message).
 *
 * Cases: UT-WATCH-01..17.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CliError } from '@agenzo/cli-core';
import type { GetOrderResponse } from '../src/types/api.js';
import {
  TERMINAL_STATUSES,
  DEFAULT_WATCH_INTERVAL_SECONDS,
  DEFAULT_WATCH_TIMEOUT_SECONDS,
  isTerminalStatus,
  statusOf,
  resolveSeconds,
  runWatch,
  ndjsonWriteLine,
  type WatchTimeoutLine,
} from '../src/ride-elife/watch.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------
// Test plumbing: a fake clock + sequence-driven fetchStatus.
// ------------------------------------------------------------

/** A monotonic fake clock; `sleep` advances time so no real time passes. */
function makeFakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Build a `fetchStatus` from a status sequence; clamps to the last element. */
function makeFetchStatus(statuses: Array<string | undefined>) {
  let i = 0;
  const calls: number[] = [];
  const fetchStatus = async (): Promise<GetOrderResponse> => {
    const idx = Math.min(i, statuses.length - 1);
    const status = statuses.length > 0 ? statuses[idx] : 'Pending';
    i += 1;
    calls.push(idx);
    return { ride_id: 'r1', status: status as string } as GetOrderResponse;
  };
  return { fetchStatus, callCount: () => calls.length };
}

function isTimeoutLine(record: unknown): record is WatchTimeoutLine {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { watch_status?: unknown }).watch_status === 'timeout'
  );
}

// ============================================================
// §4.3 pure helpers (UT-WATCH-01..10)
// ============================================================

describe('watch pure helpers (watch.ts)', () => {
  it('UT-WATCH-01: "At destination" is terminal', () => {
    expect(isTerminalStatus('At destination')).toBe(true);
  });

  it('UT-WATCH-02: all five terminal statuses are terminal', () => {
    for (const s of ['At destination', 'Cancelled', 'Rejected', 'Customer no show', 'Driver no show']) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it('UT-WATCH-03: in-progress statuses are not terminal', () => {
    for (const s of ['On board', 'Pending', 'Accepted']) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it('UT-WATCH-04: terminal matching is case-sensitive', () => {
    expect(isTerminalStatus('at destination')).toBe(false);
    expect(isTerminalStatus('CANCELLED')).toBe(false);
  });

  it('UT-WATCH-05: undefined/null status is never terminal (keep polling)', () => {
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });

  it('UT-WATCH-06: statusOf reads a string status, else undefined', () => {
    expect(statusOf({ ride_id: 'r', status: 'Pending' } as GetOrderResponse)).toBe('Pending');
    expect(statusOf({ ride_id: 'r', status: 123 as unknown as string } as GetOrderResponse)).toBeUndefined();
  });

  it('UT-WATCH-07: resolveSeconds falls back to default when undefined', () => {
    expect(resolveSeconds(undefined, 5)).toBe(5);
  });

  it('UT-WATCH-08: resolveSeconds parses a positive value', () => {
    expect(resolveSeconds('10', 5)).toBe(10);
  });

  it('UT-WATCH-09: resolveSeconds rejects non-positive / non-finite to default', () => {
    expect(resolveSeconds('0', 5)).toBe(5);
    expect(resolveSeconds('-3', 5)).toBe(5);
    expect(resolveSeconds('abc', 5)).toBe(5);
  });

  it('UT-WATCH-10: TERMINAL_STATUSES has exactly 5 members; defaults are 5 / 600', () => {
    expect(TERMINAL_STATUSES.size).toBe(5);
    expect(DEFAULT_WATCH_INTERVAL_SECONDS).toBe(5);
    expect(DEFAULT_WATCH_TIMEOUT_SECONDS).toBe(600);
  });
});

// ============================================================
// §4.4 runWatch with a fake clock (UT-WATCH-11..17)
// ============================================================

describe('runWatch (watch.ts, fake clock)', () => {
  it('UT-WATCH-11: first poll terminal → one line, no timeout line', async () => {
    const lines: unknown[] = [];
    const clock = makeFakeClock();
    const { fetchStatus, callCount } = makeFetchStatus(['At destination']);

    await runWatch(
      { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
      { intervalMs: 1000, timeoutMs: 600_000 },
    );

    expect(lines).toHaveLength(1);
    expect(statusOf(lines[0] as GetOrderResponse)).toBe('At destination');
    expect(lines.some(isTimeoutLine)).toBe(false);
    expect(callCount()).toBe(1);
  });

  it('UT-WATCH-12: multi-poll to terminal → one line per poll, last is terminal, no timeout', async () => {
    const lines: unknown[] = [];
    const clock = makeFakeClock();
    const { fetchStatus, callCount } = makeFetchStatus(['Pending', 'Accepted', 'At destination']);

    await runWatch(
      { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
      { intervalMs: 1000, timeoutMs: 600_000 },
    );

    expect(lines).toHaveLength(3);
    expect(statusOf(lines[2] as GetOrderResponse)).toBe('At destination');
    expect(lines.some(isTimeoutLine)).toBe(false);
    expect(callCount()).toBe(3);
  });

  it('UT-WATCH-13: never terminal → timeout is the LAST line; prior polls each emitted', async () => {
    const lines: unknown[] = [];
    const clock = makeFakeClock();
    const { fetchStatus } = makeFetchStatus(['Pending', 'Pending', 'Pending', 'Pending']);

    await runWatch(
      { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
      { intervalMs: 100, timeoutMs: 250 },
    );

    const last = lines[lines.length - 1];
    expect(isTimeoutLine(last)).toBe(true);
    expect((last as WatchTimeoutLine).last_status).toBe('Pending');
    // exactly one timeout line, and it is the last.
    expect(lines.filter(isTimeoutLine)).toHaveLength(1);
    // status lines before the timeout line.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines.slice(0, -1)) {
      expect(isTimeoutLine(l)).toBe(false);
    }
  });

  it('UT-WATCH-14: timeout on the very first budget check still writes a status line + timeout line', async () => {
    const lines: unknown[] = [];
    const clock = makeFakeClock();
    const { fetchStatus } = makeFetchStatus(['Pending']);

    await runWatch(
      { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
      { intervalMs: 100, timeoutMs: 50 },
    );

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(isTimeoutLine(lines[lines.length - 1])).toBe(true);
    expect((lines[lines.length - 1] as WatchTimeoutLine).last_status).toBe('Pending');
  });

  it('UT-WATCH-15: a fetchStatus error propagates (aborts the stream)', async () => {
    const lines: unknown[] = [];
    const clock = makeFakeClock();
    const boom = new CliError('UPSTREAM_ERROR', 'network down');
    const fetchStatus = vi.fn().mockRejectedValue(boom);

    await expect(
      runWatch(
        { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
        { intervalMs: 100, timeoutMs: 1000 },
      ),
    ).rejects.toBe(boom);
    expect(lines).toHaveLength(0);
  });

  it('UT-WATCH-16: ndjsonWriteLine emits one compact single-line JSON + trailing newline', () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      written.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });

    const record = { ride_id: 'r1', status: 'Pending', nested: { a: 1 } };
    ndjsonWriteLine(record);

    expect(written).toHaveLength(1);
    const line = written[0];
    // compact: equals JSON.stringify(record) + '\n' (no indentation).
    expect(line).toBe(`${JSON.stringify(record)}\n`);
    // exactly one newline, at the very end (single-line record).
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line.trim())).toEqual(record);
  });

  it('UT-WATCH-17: timeout message contains `${timeoutMs/1000}s` and watch_status literal', async () => {
    const lines: unknown[] = [];
    const clock = makeFakeClock();
    const { fetchStatus } = makeFetchStatus(['Pending', 'Pending']);

    await runWatch(
      { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
      { intervalMs: 1000, timeoutMs: 2000 },
    );

    const timeout = lines.find(isTimeoutLine) as WatchTimeoutLine;
    expect(timeout).toBeDefined();
    expect(timeout.watch_status).toBe('timeout');
    expect(timeout.message).toContain('2s');
  });
});

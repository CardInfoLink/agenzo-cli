/**
 * Property-based tests (fast-check) — test-design §4.8.
 *
 * Property 3 / Req 5.3 — idempotency key format `[A-Za-z0-9_-]{1,128}`:
 *   PBT-IDEM-01  every in-class key of length 1–128 is accepted verbatim.
 *   PBT-IDEM-02  any out-of-class / length-0 / length->128 key is rejected
 *                with PARAM_INVALID.
 *   PBT-IDEM-03  under --yes a missing key always throws
 *                IdempotencyKeyRequiredError (never auto-generated).
 *
 * Property 2 / Req 3.2 — NDJSON watch (fake clock):
 *   PBT-WATCH-01 any status sequence + positive interval/timeout terminates
 *                with a finite number of lines.
 *   PBT-WATCH-02 a never-terminal sequence ends with exactly one timeout line,
 *                and it is the last line.
 *   PBT-WATCH-03 a sequence ending in a terminal status stops at it (no further
 *                poll / line), with no timeout line.
 *   PBT-WATCH-04 every NDJSON line is single-line and JSON.parse-able.
 *
 * **Validates: Requirements 5.3, 3.2**
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  CliError,
  IdempotencyKeyRequiredError,
  PromptEngine,
  type GetOrderResponse,
} from '@agenzo/cli-core';
import { normalizeIdempotencyKey, resolveIdempotencyKey } from '../src/idempotency.js';
import {
  TERMINAL_STATUSES,
  runWatch,
  ndjsonWriteLine,
  type WatchTimeoutLine,
} from '../src/ride-elife/watch.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const TERMINAL_LIST = [...TERMINAL_STATUSES];

function makeFakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** sequence-driven fetchStatus; clamps to the last element when exhausted. */
function makeFetchStatus(statuses: string[]) {
  let i = 0;
  let calls = 0;
  const fetchStatus = async (): Promise<GetOrderResponse> => {
    const idx = statuses.length > 0 ? Math.min(i, statuses.length - 1) : 0;
    const status = statuses.length > 0 ? statuses[idx] : 'Pending';
    i += 1;
    calls += 1;
    return { ride_id: 'r1', status } as GetOrderResponse;
  };
  return { fetchStatus, callCount: () => calls };
}

function isTimeoutLine(record: unknown): record is WatchTimeoutLine {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { watch_status?: unknown }).watch_status === 'timeout'
  );
}

// ============================================================
// Property 3 / Req 5.3 — idempotency key format
// ============================================================

describe('PBT — idempotency key format (Property 3 / Req 5.3)', () => {
  it('PBT-IDEM-01: any [A-Za-z0-9_-]{1,128} key is accepted verbatim', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), (s) => {
        expect(normalizeIdempotencyKey(s)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('PBT-IDEM-02: any out-of-class / empty / over-128 key is rejected with PARAM_INVALID', () => {
    // length-0
    const empty = fc.constant('');
    // length > 128 (in-class chars, so only length makes it invalid)
    const tooLong = fc.integer({ min: 129, max: 400 }).map((n) => 'a'.repeat(n));
    // a bad char sandwiched between two in-class cores so trim cannot rescue it
    const core = fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/);
    const badChar = fc.constantFrom(' ', '!', '@', '#', '/', '\t', '中', '😀', '\n');
    const withBadChar = fc
      .tuple(core, badChar, core)
      .map(([a, b, c]) => `${a}${b}${c}`);

    const invalid = fc.oneof(empty, tooLong, withBadChar);

    fc.assert(
      fc.property(invalid, (s) => {
        let caught: unknown;
        try {
          normalizeIdempotencyKey(s);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(CliError);
        expect((caught as CliError).code).toBe('PARAM_INVALID');
      }),
      { numRuns: 500 },
    );
  });

  it('PBT-IDEM-03: missing key under --yes always throws IdempotencyKeyRequiredError (never auto-generates)', async () => {
    const spy = vi.spyOn(PromptEngine, 'resolveInput');
    await fc.assert(
      fc.asyncProperty(fc.string(), async (commandPath) => {
        let caught: unknown;
        try {
          await resolveIdempotencyKey(undefined, { yes: true, commandPath });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(IdempotencyKeyRequiredError);
        expect((caught as CliError).code).toBe('PARAM_IDEMPOTENCY_KEY_REQUIRED');
      }),
      { numRuns: 200 },
    );
    // hard error path never consults the prompt engine.
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================
// Property 2 / Req 3.2 — NDJSON watch termination + invariants
// ============================================================

describe('PBT — NDJSON watch (Property 2 / Req 3.2)', () => {
  // Any status (terminal or not), bounded length.
  const anyStatus = fc.oneof(
    fc.constantFrom(...TERMINAL_LIST),
    fc.string(),
    fc.constantFrom('Pending', 'Accepted', 'On board'),
  );
  const nonTerminalStatus = fc
    .string()
    .filter((s) => !TERMINAL_STATUSES.has(s))
    .map((s) => (s.length === 0 ? 'Pending' : s));

  it('PBT-WATCH-01: any sequence + positive interval/timeout terminates with finite lines', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyStatus, { maxLength: 12 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 30 }),
        async (statuses, intervalMs, k) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const { fetchStatus } = makeFetchStatus(statuses);
          await runWatch(
            { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
            { intervalMs, timeoutMs: intervalMs * k },
          );
          // terminated (we got here) with a finite, non-empty set of lines.
          expect(Number.isFinite(lines.length)).toBe(true);
          expect(lines.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('PBT-WATCH-02: a never-terminal sequence ends with exactly one timeout line (the last)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalStatus, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 30 }),
        async (statuses, intervalMs, k) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const { fetchStatus } = makeFetchStatus(statuses);
          await runWatch(
            { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
            { intervalMs, timeoutMs: intervalMs * k },
          );
          expect(isTimeoutLine(lines[lines.length - 1])).toBe(true);
          expect(lines.filter(isTimeoutLine)).toHaveLength(1);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('PBT-WATCH-03: a sequence ending in a terminal status stops there, no timeout line', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalStatus, { maxLength: 10 }),
        fc.constantFrom(...TERMINAL_LIST),
        fc.integer({ min: 1, max: 1000 }),
        async (leading, terminal, intervalMs) => {
          const statuses = [...leading, terminal];
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const { fetchStatus, callCount } = makeFetchStatus(statuses);
          // timeout budget far exceeds the polls needed to reach the terminal.
          const timeoutMs = intervalMs * (statuses.length + 5) * 10;
          await runWatch(
            { fetchStatus, writeLine: (r) => lines.push(r), sleep: clock.sleep, now: clock.now },
            { intervalMs, timeoutMs },
          );
          // stopped at the terminal status: one poll/line per status, no more.
          expect(callCount()).toBe(statuses.length);
          expect(lines).toHaveLength(statuses.length);
          expect(lines.some(isTimeoutLine)).toBe(false);
          expect((lines[lines.length - 1] as GetOrderResponse).status).toBe(terminal);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('PBT-WATCH-04: every NDJSON line is single-line and JSON.parse-able', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (record) => {
        const written: string[] = [];
        const spy = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation((c: string | Uint8Array) => {
            written.push(typeof c === 'string' ? c : Buffer.from(c).toString());
            return true;
          });
        try {
          ndjsonWriteLine(record);
        } finally {
          spy.mockRestore();
        }
        expect(written).toHaveLength(1);
        const line = written[0];
        // exactly one newline, and it is the trailing terminator (single-line).
        expect(line.endsWith('\n')).toBe(true);
        expect(line.indexOf('\n')).toBe(line.length - 1);
        // JSON.parse succeeds on the emitted line.
        expect(() => JSON.parse(line.trim())).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

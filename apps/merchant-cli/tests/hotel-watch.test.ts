/**
 * Property-based tests for the hotel NDJSON watch engine
 * (`src/hotel-redaug/watch.ts`) — design Properties 9 & 10.
 *
 * Uses fast-check (≥100 iterations) with a FAKE clock and injectable seams
 * (no real timers, no network). Mirrors `tests/watch.test.ts` (ride) pattern.
 *
 * Feature: merchant-cli-hotel-redaug
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  isTerminalOrderStatus,
  isTerminalRefundStatus,
  lastOrderStatusOf,
  lastRefundStatusOf,
  runHotelWatch,
  HOTEL_TERMINAL_ORDER_CODES,
  HOTEL_TERMINAL_ORDER_STATUS,
  CHECKOUT_TERMINAL_REFUND,
  type HotelWatchDeps,
  type HotelWatchTimeoutLine,
} from '../src/hotel-redaug/watch.js';

// ============================================================
// Test helpers — fake clock + sequence-driven fetchStatus
// ============================================================

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

function isTimeoutLine(record: unknown): record is HotelWatchTimeoutLine {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { watch_status?: unknown }).watch_status === 'timeout'
  );
}

// ============================================================
// Property 9: Watch terminal-status detection
// Validates: Requirements 5.4, 8.4
// ============================================================

describe('Property 9: Watch terminal-status detection', () => {
  // -- Order status: isTerminalOrderStatus --

  // Feature: merchant-cli-hotel-redaug, Property 9: terminal order status via code
  it('isTerminalOrderStatus returns true exactly for order_status_code ∈ {3,4,5}', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (code) => {
        const record = { order_status_code: code };
        const expected = HOTEL_TERMINAL_ORDER_CODES.has(code);
        expect(isTerminalOrderStatus(record)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 9: terminal order status via string
  it('isTerminalOrderStatus returns true exactly for order_status ∈ {CONFIRMED,CANCELLED,COMPLETED}', () => {
    const allStatuses = [
      'CONFIRMED',
      'CANCELLED',
      'COMPLETED',
      'PROCESSING',
      'INIT',
      'PENDING',
      'confirmed',
      'cancelled',
      'completed',
      '',
    ];
    fc.assert(
      fc.property(fc.constantFrom(...allStatuses), (status) => {
        const record = { order_status: status };
        const expected = HOTEL_TERMINAL_ORDER_STATUS.has(status);
        expect(isTerminalOrderStatus(record)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 9: terminal order status with both fields
  it('isTerminalOrderStatus returns true when EITHER code or string is terminal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 10 }),
        fc.constantFrom(
          'CONFIRMED',
          'CANCELLED',
          'COMPLETED',
          'PROCESSING',
          'INIT',
          'UNKNOWN',
        ),
        (code, status) => {
          const record = { order_status_code: code, order_status: status };
          const terminalByCode = HOTEL_TERMINAL_ORDER_CODES.has(code);
          const terminalByString = HOTEL_TERMINAL_ORDER_STATUS.has(status);
          expect(isTerminalOrderStatus(record)).toBe(terminalByCode || terminalByString);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 9: missing/undefined fields are never terminal
  it('isTerminalOrderStatus returns false for records without relevant fields', () => {
    fc.assert(
      fc.property(
        fc.record({
          order_id: fc.string(),
          some_field: fc.nat(),
        }),
        (record) => {
          expect(isTerminalOrderStatus(record)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 9: arbitrary string order_status
  it('isTerminalOrderStatus returns true only for the exact terminal strings (arbitrary strings)', () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        const record = { order_status: status };
        const expected = HOTEL_TERMINAL_ORDER_STATUS.has(status);
        expect(isTerminalOrderStatus(record)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // -- Refund status: isTerminalRefundStatus --

  // Feature: merchant-cli-hotel-redaug, Property 9: terminal refund status
  it('isTerminalRefundStatus returns true exactly for refund_status ∈ {approved,rejected,refunded}', () => {
    const allStatuses = [
      'approved',
      'rejected',
      'refunded',
      'pending',
      'processing',
      'APPROVED',
      'Rejected',
      '',
    ];
    fc.assert(
      fc.property(fc.constantFrom(...allStatuses), (status) => {
        const record = { refund_status: status };
        const expected = CHECKOUT_TERMINAL_REFUND.has(status);
        expect(isTerminalRefundStatus(record)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 9: arbitrary refund_status strings
  it('isTerminalRefundStatus returns true only for the exact terminal strings (arbitrary strings)', () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        const record = { refund_status: status };
        const expected = CHECKOUT_TERMINAL_REFUND.has(status);
        expect(isTerminalRefundStatus(record)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 9: missing refund_status is never terminal
  it('isTerminalRefundStatus returns false for records without refund_status', () => {
    fc.assert(
      fc.property(
        fc.record({
          task_order_code: fc.string(),
          amount: fc.nat(),
        }),
        (record) => {
          expect(isTerminalRefundStatus(record)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 10: Watch stream terminates and emits a single raw NDJSON timeout line
// Validates: Requirements 5.4, 5.5, 5.6, 8.4, 8.5, 11.4
// ============================================================

describe('Property 10: Watch stream terminates and emits a single raw NDJSON timeout line', () => {
  // -- Helper: build a fetchStatus from a sequence of records (clamps to last) --
  function makeFetchStatusFromRecords(records: unknown[]) {
    let i = 0;
    return async (): Promise<unknown> => {
      const idx = Math.min(i, records.length - 1);
      i += 1;
      return records[idx];
    };
  }

  // -- Arbitrary generators --

  /** Generate a non-terminal order record. */
  const nonTerminalOrderRecord = fc.record({
    order_id: fc.string({ minLength: 1, maxLength: 8 }),
    order_status: fc.constantFrom('PROCESSING', 'INIT', 'PENDING'),
    order_status_code: fc.constantFrom(2, 0, 1),
  });

  /** Generate a terminal order record. */
  const terminalOrderRecord = fc.oneof(
    fc.record({
      order_id: fc.string({ minLength: 1, maxLength: 8 }),
      order_status: fc.constantFrom('CONFIRMED', 'CANCELLED', 'COMPLETED'),
      order_status_code: fc.constantFrom(3, 4, 5),
    }),
    fc.record({
      order_id: fc.string({ minLength: 1, maxLength: 8 }),
      order_status: fc.constantFrom('CONFIRMED', 'CANCELLED', 'COMPLETED'),
    }),
    fc.record({
      order_id: fc.string({ minLength: 1, maxLength: 8 }),
      order_status_code: fc.constantFrom(3, 4, 5),
    }),
  );

  /** Generate a non-terminal refund record. */
  const nonTerminalRefundRecord = fc.record({
    task_order_code: fc.string({ minLength: 1, maxLength: 8 }),
    refund_status: fc.constantFrom('pending', 'processing', 'unknown'),
  });

  /** Generate a terminal refund record. */
  const terminalRefundRecord = fc.record({
    task_order_code: fc.string({ minLength: 1, maxLength: 8 }),
    refund_status: fc.constantFrom('approved', 'rejected', 'refunded'),
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: reaches terminal → stops, no timeout
  it('order watch: sequence reaching terminal status stops with no timeout line', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalOrderRecord, { minLength: 0, maxLength: 10 }),
        terminalOrderRecord,
        fc.integer({ min: 100, max: 1000 }),
        async (prefix, terminal, intervalMs) => {
          // Ensure timeout is large enough to reach the terminal record
          const timeoutMs = (prefix.length + 2) * intervalMs;
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const sequence = [...prefix, terminal];
          const fetchStatus = makeFetchStatusFromRecords(sequence);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalOrderStatus,
            lastStatusOf: lastOrderStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs });

          // No timeout line emitted
          expect(lines.filter(isTimeoutLine)).toHaveLength(0);
          // Lines ≤ sequence length
          expect(lines.length).toBeLessThanOrEqual(sequence.length);
          // The last line should be terminal
          expect(isTerminalOrderStatus(lines[lines.length - 1])).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: never terminal → exactly one timeout as last line
  it('order watch: sequence never reaching terminal emits exactly one timeout as last line', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalOrderRecord, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 100, max: 5000 }),
        async (records, intervalMs, timeoutMs) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const fetchStatus = makeFetchStatusFromRecords(records);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalOrderStatus,
            lastStatusOf: lastOrderStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs });

          // At least one status line + one timeout line
          expect(lines.length).toBeGreaterThanOrEqual(2);
          // Exactly one timeout line
          const timeoutLines = lines.filter(isTimeoutLine);
          expect(timeoutLines).toHaveLength(1);
          // The timeout line is the LAST line
          expect(isTimeoutLine(lines[lines.length - 1])).toBe(true);
          // All non-timeout lines are valid status records (not timeout)
          for (const l of lines.slice(0, -1)) {
            expect(isTimeoutLine(l)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: every emitted line is JSON.parse-able compact
  it('order watch: every emitted line is a single compact JSON.parse-able object', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalOrderRecord, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 100, max: 500 }),
        fc.integer({ min: 100, max: 2000 }),
        async (records, intervalMs, timeoutMs) => {
          const rawLines: string[] = [];
          const clock = makeFakeClock();
          const fetchStatus = makeFetchStatusFromRecords(records);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => rawLines.push(JSON.stringify(r)),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalOrderStatus,
            lastStatusOf: lastOrderStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs });

          for (const line of rawLines) {
            // Must be parseable
            const parsed = JSON.parse(line);
            expect(typeof parsed).toBe('object');
            expect(parsed).not.toBeNull();
            // Compact: no embedded newlines (single-line JSON)
            expect(line).not.toContain('\n');
            // Round-trip equals compact form
            expect(line).toBe(JSON.stringify(parsed));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: engine always terminates (bounded iterations)
  it('order watch: engine always terminates for any sequence + positive interval/timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalOrderRecord, { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 100000 }),
        async (records, intervalMs, timeoutMs) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const fetchStatus = makeFetchStatusFromRecords(records);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalOrderStatus,
            lastStatusOf: lastOrderStatusOf,
          };

          // Must resolve (not hang)
          await runHotelWatch(deps, { intervalMs, timeoutMs });
          expect(lines.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: refund watch — terminal stops without timeout
  it('refund watch: sequence reaching terminal refund status stops with no timeout line', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalRefundRecord, { minLength: 0, maxLength: 10 }),
        terminalRefundRecord,
        fc.integer({ min: 100, max: 1000 }),
        async (prefix, terminal, intervalMs) => {
          // Ensure timeout is large enough to reach the terminal record
          const timeoutMs = (prefix.length + 2) * intervalMs;
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const sequence = [...prefix, terminal];
          const fetchStatus = makeFetchStatusFromRecords(sequence);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalRefundStatus,
            lastStatusOf: lastRefundStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs });

          expect(lines.filter(isTimeoutLine)).toHaveLength(0);
          expect(lines.length).toBeLessThanOrEqual(sequence.length);
          expect(isTerminalRefundStatus(lines[lines.length - 1])).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: refund watch — never terminal emits timeout
  it('refund watch: sequence never reaching terminal emits exactly one timeout as last line', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalRefundRecord, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 100, max: 5000 }),
        async (records, intervalMs, timeoutMs) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const fetchStatus = makeFetchStatusFromRecords(records);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalRefundStatus,
            lastStatusOf: lastRefundStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs });

          expect(lines.length).toBeGreaterThanOrEqual(2);
          const timeoutLines = lines.filter(isTimeoutLine);
          expect(timeoutLines).toHaveLength(1);
          expect(isTimeoutLine(lines[lines.length - 1])).toBe(true);
          for (const l of lines.slice(0, -1)) {
            expect(isTimeoutLine(l)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: timeout line has correct shape
  it('timeout line contains watch_status, message with timeout duration, and last_status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalOrderRecord, { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 100, max: 5000 }),
        async (records, intervalMs, timeoutMs) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const fetchStatus = makeFetchStatusFromRecords(records);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalOrderStatus,
            lastStatusOf: lastOrderStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs });

          const timeout = lines.find(isTimeoutLine) as HotelWatchTimeoutLine;
          expect(timeout).toBeDefined();
          expect(timeout.watch_status).toBe('timeout');
          expect(timeout.message).toContain(`${timeoutMs / 1000}s`);
          expect('last_status' in timeout).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: merchant-cli-hotel-redaug, Property 10: writeLine called ≤ sequence length for terminal
  it('writeLine called ≤ sequence length when terminal is reached', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonTerminalOrderRecord, { minLength: 0, maxLength: 8 }),
        terminalOrderRecord,
        fc.integer({ min: 100, max: 5000 }),
        async (prefix, terminal, intervalMs) => {
          const lines: unknown[] = [];
          const clock = makeFakeClock();
          const sequence = [...prefix, terminal];
          const fetchStatus = makeFetchStatusFromRecords(sequence);
          const deps: HotelWatchDeps = {
            fetchStatus,
            writeLine: (r) => lines.push(r),
            sleep: clock.sleep,
            now: clock.now,
            isTerminal: isTerminalOrderStatus,
            lastStatusOf: lastOrderStatusOf,
          };

          await runHotelWatch(deps, { intervalMs, timeoutMs: 600_000 });
          expect(lines.length).toBeLessThanOrEqual(sequence.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import type { ApiClient } from '@agenzo/cli-core';
import { CliError } from '@agenzo/cli-core';
import type { GetCheckoutResponse, GetHotelOrderResponse } from '../types/hotel.js';
import { ndjsonWriteLine, realSleep, resolveSeconds } from '../ride-elife/watch.js';

/**
 * NDJSON status-polling for the hotel long-running reads `hotel-redaug get
 * --watch` (Requirement 5.4-5.6) and `hotel-redaug get-checkout --watch`
 * (Requirement 8.4-8.5). Merchant-domain logic — stays in the app per
 * requirement 15.x (NOT pushed down to cli-core), mirroring `ride-elife/watch.ts`.
 *
 * The watch stream is a line stream: each poll result is written as ONE
 * independent, compact JSON line on stdout. It is deliberately NOT routed
 * through `renderWithContext`, so the profile/endpoint envelope is never
 * wrapped around the stream (Requirement 11.4 — an agent consumes it with a
 * line reader).
 *
 * The polling engine is split from its I/O so it can be unit/PBT-tested with a
 * fake clock and shortened constants (Requirement 15.5): `fetchStatus`,
 * `writeLine`, `sleep`, `now`, `isTerminal` and `lastStatusOf` are all
 * injected. Unlike `ride-elife` (single verb), the hotel engine serves two
 * verbs with different terminal semantics, so the terminal predicate and the
 * "last status" accessor are injected seams rather than hard-coded.
 *
 * `resolveSeconds`, `realSleep` and `ndjsonWriteLine` are reused verbatim from
 * the ride watch module (which already exports them) and re-exported here so
 * the hotel verb modules can pull the whole watch surface from this single,
 * self-contained module.
 */

export { ndjsonWriteLine, realSleep, resolveSeconds };

// ============================================================
// Defaults (per the verb-schema `polling` blocks)
// ============================================================

/** `get` schema `polling.recommended_interval_seconds`. */
export const DEFAULT_ORDER_WATCH_INTERVAL_SECONDS = 5;
/** `get-checkout` schema `polling.recommended_interval_seconds`. */
export const DEFAULT_CHECKOUT_WATCH_INTERVAL_SECONDS = 10;
/** Safety cap so `--watch` can never poll forever (shared by both verbs). */
export const DEFAULT_WATCH_TIMEOUT_SECONDS = 600;

// ============================================================
// Terminal predicates + constants — order status (`get`)
// ============================================================

/**
 * Terminal `order_status_code` set (schema `polling.terminal_statuses`). Once
 * the order reaches one of these, `--watch` stops polling. 3 = Confirmed,
 * 4 = Cancelled, 5 = Completed.
 */
export const HOTEL_TERMINAL_ORDER_CODES: ReadonlySet<number> = new Set([3, 4, 5]);
/** In-progress `order_status_code` set (schema `polling.in_progress_statuses`). 2 = Processing. */
export const HOTEL_IN_PROGRESS_ORDER_CODES: ReadonlySet<number> = new Set([2]);
/**
 * Terminal `order_status` STRING set — the local-cache fallback path omits
 * `order_status_code`, so the string is the robust signal there. CASE-SENSITIVE.
 */
export const HOTEL_TERMINAL_ORDER_STATUS: ReadonlySet<string> = new Set([
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
]);

/** Read the integer `order_status_code` off a poll result (provider path only). */
export function orderStatusCodeOf(record: unknown): number | undefined {
  const code = (record as { order_status_code?: unknown }).order_status_code;
  return typeof code === 'number' ? code : undefined;
}

/** Read the std `order_status` STRING off a poll result. */
export function orderStatusOf(record: unknown): string | undefined {
  const status = (record as { order_status?: unknown }).order_status;
  return typeof status === 'string' ? status : undefined;
}

/**
 * Pure terminal-state predicate for `get` (exported for direct unit/PBT
 * testing). True when `order_status_code ∈ {3,4,5}` OR `order_status ∈
 * {CONFIRMED, CANCELLED, COMPLETED}` — robust across the provider path (carries
 * both the int and the string) and the local-cache fallback (string only). A
 * missing/unknown status is never terminal, so polling continues until a known
 * terminal status or the timeout.
 */
export function isTerminalOrderStatus(record: unknown): boolean {
  const code = orderStatusCodeOf(record);
  if (code !== undefined && HOTEL_TERMINAL_ORDER_CODES.has(code)) {
    return true;
  }
  const status = orderStatusOf(record);
  return status !== undefined && HOTEL_TERMINAL_ORDER_STATUS.has(status);
}

/**
 * Most recent order status for the timeout line: the human-readable
 * `order_status` string when present, else the integer `order_status_code`,
 * else null.
 */
export function lastOrderStatusOf(record: unknown): string | number | null {
  return orderStatusOf(record) ?? orderStatusCodeOf(record) ?? null;
}

// ============================================================
// Terminal predicates + constants — refund status (`get-checkout`)
// ============================================================

/** Terminal `refund_status` set (schema `polling.terminal_statuses`). */
export const CHECKOUT_TERMINAL_REFUND: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'refunded',
]);
/** In-progress `refund_status` set (schema `polling.in_progress_statuses`). */
export const CHECKOUT_IN_PROGRESS_REFUND: ReadonlySet<string> = new Set(['pending']);

/** Read the `refund_status` STRING off a check-out poll result. */
export function refundStatusOf(record: unknown): string | undefined {
  const status = (record as { refund_status?: unknown }).refund_status;
  return typeof status === 'string' ? status : undefined;
}

/**
 * Pure terminal-state predicate for `get-checkout` (exported for direct
 * unit/PBT testing). True when `refund_status ∈ {approved, rejected,
 * refunded}`. A missing/unknown status is never terminal.
 */
export function isTerminalRefundStatus(record: unknown): boolean {
  const status = refundStatusOf(record);
  return status !== undefined && CHECKOUT_TERMINAL_REFUND.has(status);
}

/** Most recent refund status for the timeout line, or null when absent. */
export function lastRefundStatusOf(record: unknown): string | number | null {
  return refundStatusOf(record) ?? null;
}

// ============================================================
// Engine (pure, fully injected)
// ============================================================

/** The final NDJSON line emitted when polling gives up before a terminal status. */
export interface HotelWatchTimeoutLine {
  watch_status: 'timeout';
  message: string;
  last_status: string | number | null;
}

/** I/O + clock + predicate seams the polling engine depends on (all injectable for tests). */
export interface HotelWatchDeps {
  /** Fetch one status snapshot (throws to abort the whole stream). */
  fetchStatus: () => Promise<unknown>;
  /** Write one NDJSON record as a single compact line. */
  writeLine: (record: unknown) => void;
  /** Resolve after `ms` (real timer in prod; fake clock in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Current epoch millis (real `Date.now` in prod; fake clock in tests). */
  now: () => number;
  /** Verb-specific terminal-state predicate. */
  isTerminal: (record: unknown) => boolean;
  /** Verb-specific accessor for the timeout line's `last_status`. */
  lastStatusOf: (record: unknown) => string | number | null;
}

/** Interval / timeout budget for one watch run, in milliseconds. */
export interface HotelWatchOptions {
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Poll `fetchStatus`, writing each result as an NDJSON line, until the record
 * reaches a terminal status (per the injected `isTerminal`) or the timeout
 * elapses. On timeout the FINAL line is `{ watch_status: 'timeout', ... }`
 * (Requirements 5.5 / 8.5).
 *
 * Termination: every iteration either returns (terminal status) or, when the
 * next poll would land at/after the deadline, emits the timeout line and
 * returns. With a monotonically advancing clock (real time, or a fake clock
 * advanced by `sleep`) the deadline is always reached, so the loop is
 * guaranteed to terminate for any status sequence. Loop shape is identical to
 * `ride-elife`'s `runWatch`.
 */
export async function runHotelWatch(
  deps: HotelWatchDeps,
  opts: HotelWatchOptions,
): Promise<void> {
  const deadline = deps.now() + opts.timeoutMs;
  for (;;) {
    const record = await deps.fetchStatus();
    deps.writeLine(record);

    if (deps.isTerminal(record)) {
      return;
    }

    if (deps.now() + opts.intervalMs >= deadline) {
      const timeoutLine: HotelWatchTimeoutLine = {
        watch_status: 'timeout',
        message: `Polling stopped after ${opts.timeoutMs / 1000}s without reaching a terminal status.`,
        last_status: deps.lastStatusOf(record),
      };
      deps.writeLine(timeoutLine);
      return;
    }

    await deps.sleep(opts.intervalMs);
  }
}

// ============================================================
// Production wirings (live endpoints, real timers, system clock)
// ============================================================

/**
 * Production wiring for `hotel-redaug get --watch`: bind the polling engine to
 * a live `ApiClient` (order-status endpoint + api-key auth), the compact NDJSON
 * stdout writer, real timers and the system clock. A network/backend failure on
 * any poll surfaces as a `CliError` to the top-level handler, exactly like the
 * single-shot path. The order is terminal at `order_status_code ∈ {3,4,5}`
 * (or `order_status ∈ {CONFIRMED, CANCELLED, COMPLETED}`).
 */
export async function watchOrderStatus(
  apiClient: ApiClient,
  apiKey: string,
  orderId: string,
  opts: { intervalSeconds: number; timeoutSeconds: number },
): Promise<void> {
  const path = `/hotel/${encodeURIComponent(orderId)}/status`;
  await runHotelWatch(
    {
      fetchStatus: async () => {
        const result = await apiClient.get<GetHotelOrderResponse>(path, {
          type: 'api-key',
          key: apiKey,
        });
        if (!result.success) {
          throw CliError.fromApi(result, { auth: 'api-key' });
        }
        return result.data;
      },
      writeLine: ndjsonWriteLine,
      sleep: realSleep,
      now: () => Date.now(),
      isTerminal: isTerminalOrderStatus,
      lastStatusOf: lastOrderStatusOf,
    },
    {
      intervalMs: opts.intervalSeconds * 1000,
      timeoutMs: opts.timeoutSeconds * 1000,
    },
  );
}

/**
 * Production wiring for `hotel-redaug get-checkout --watch`: bind the polling
 * engine to a live `ApiClient` (checkout-status endpoint + api-key auth), the
 * compact NDJSON stdout writer, real timers and the system clock. A poll
 * failure surfaces as a `CliError` to the top-level handler. The refund is
 * terminal at `refund_status ∈ {approved, rejected, refunded}`.
 */
export async function watchCheckoutStatus(
  apiClient: ApiClient,
  apiKey: string,
  taskOrderCode: string,
  opts: { intervalSeconds: number; timeoutSeconds: number },
): Promise<void> {
  const path = `/hotel/checkout/${encodeURIComponent(taskOrderCode)}`;
  await runHotelWatch(
    {
      fetchStatus: async () => {
        const result = await apiClient.get<GetCheckoutResponse>(path, {
          type: 'api-key',
          key: apiKey,
        });
        if (!result.success) {
          throw CliError.fromApi(result, { auth: 'api-key' });
        }
        return result.data;
      },
      writeLine: ndjsonWriteLine,
      sleep: realSleep,
      now: () => Date.now(),
      isTerminal: isTerminalRefundStatus,
      lastStatusOf: lastRefundStatusOf,
    },
    {
      intervalMs: opts.intervalSeconds * 1000,
      timeoutMs: opts.timeoutSeconds * 1000,
    },
  );
}

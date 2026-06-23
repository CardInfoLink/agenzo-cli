import type { ApiClient } from '@agenzo/cli-core';
import { CliError } from '@agenzo/cli-core';
import type { GetOrderResponse } from '../types/api.js';

/**
 * NDJSON status-polling for `ride-elife get --watch` (§4.4.1.3 polling /
 * design Property 2). Merchant-domain logic — stays in the app per
 * requirement 4.4 (NOT pushed down to cli-core).
 *
 * The watch stream is a line stream: each poll result is written as ONE
 * independent, compact JSON line on stdout. It is deliberately NOT routed
 * through `renderWithContext`, so the profile/endpoint envelope is never
 * wrapped around the stream (an agent consumes it with a line reader).
 *
 * The polling engine is split from its I/O so it can be unit/PBT-tested with a
 * fake clock and shortened constants (task 6.5): `fetchStatus`, `writeLine`,
 * `sleep` and `now` are all injected.
 */

/**
 * Terminal ride statuses (schema `polling.terminal_statuses`). Once the order
 * reaches one of these, `--watch` stops polling. CASE-SENSITIVE — must match
 * the server casing exactly.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'At destination',
  'Cancelled',
  'Rejected',
  'Customer no show',
  'Driver no show',
]);

/** Schema `polling.recommended_interval_seconds`. */
export const DEFAULT_WATCH_INTERVAL_SECONDS = 5;
/** Safety cap so `--watch` can never poll forever. */
export const DEFAULT_WATCH_TIMEOUT_SECONDS = 600;

/**
 * Pure terminal-state predicate (exported for direct unit/PBT testing). A
 * missing/undefined status is never terminal, so polling continues until a
 * known terminal status or the timeout.
 */
export function isTerminalStatus(status: string | undefined | null): boolean {
  return status !== undefined && status !== null && TERMINAL_STATUSES.has(status);
}

/** Read the case-sensitive `status` field off a poll result. */
export function statusOf(data: GetOrderResponse): string | undefined {
  const status = (data as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

/** The final NDJSON line emitted when polling gives up before a terminal status. */
export interface WatchTimeoutLine {
  watch_status: 'timeout';
  message: string;
  last_status: string | null;
}

/** I/O + clock seams the polling engine depends on (all injectable for tests). */
export interface WatchEngineDeps {
  /** Fetch one status snapshot (throws to abort the whole stream). */
  fetchStatus: () => Promise<GetOrderResponse>;
  /** Write one NDJSON record as a single compact line. */
  writeLine: (record: unknown) => void;
  /** Resolve after `ms` (real timer in prod; fake clock in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Current epoch millis (real `Date.now` in prod; fake clock in tests). */
  now: () => number;
}

/** Interval / timeout budget for one watch run, in milliseconds. */
export interface WatchEngineOptions {
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Poll `fetchStatus`, writing each result as an NDJSON line, until the order
 * reaches a terminal status or the timeout elapses. On timeout the FINAL line
 * is `{ watch_status: 'timeout', ... }` (requirement 3.2 / Property 2).
 *
 * Termination: every iteration either returns (terminal status) or, when the
 * next poll would land at/after the deadline, emits the timeout line and
 * returns. With a monotonically advancing clock (real time, or a fake clock
 * advanced by `sleep`) the deadline is always reached, so the loop is
 * guaranteed to terminate for any status sequence.
 */
export async function runWatch(
  deps: WatchEngineDeps,
  opts: WatchEngineOptions,
): Promise<void> {
  const deadline = deps.now() + opts.timeoutMs;
  for (;;) {
    const data = await deps.fetchStatus();
    deps.writeLine(data);

    const status = statusOf(data);
    if (isTerminalStatus(status)) {
      return;
    }

    if (deps.now() + opts.intervalMs >= deadline) {
      const timeoutLine: WatchTimeoutLine = {
        watch_status: 'timeout',
        message: `Polling stopped after ${opts.timeoutMs / 1000}s without reaching a terminal status.`,
        last_status: status ?? null,
      };
      deps.writeLine(timeoutLine);
      return;
    }

    await deps.sleep(opts.intervalMs);
  }
}

/**
 * Parse a positive `--watch-*` seconds flag, falling back to a default when
 * absent or non-positive (mirrors the standalone reference behaviour). Returns
 * a value in SECONDS.
 */
export function resolveSeconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Real-timer sleep used by the production watch path. */
export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Compact single-line NDJSON writer used by the production watch path. */
export const ndjsonWriteLine = (record: unknown): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

/**
 * Production wiring for `ride-elife get --watch`: bind the polling engine to a
 * live `ApiClient` (status endpoint + api-key auth), the compact NDJSON stdout
 * writer, real timers and the system clock. A network/backend failure on any
 * poll surfaces as a `CliError` to the top-level handler, exactly like the
 * single-shot path.
 */
export async function watchRideStatus(
  apiClient: ApiClient,
  apiKey: string,
  orderId: string,
  opts: { intervalSeconds: number; timeoutSeconds: number },
): Promise<void> {
  const path = `/ride/${encodeURIComponent(orderId)}/status`;
  await runWatch(
    {
      fetchStatus: async () => {
        const result = await apiClient.get<GetOrderResponse>(path, {
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
    },
    {
      intervalMs: opts.intervalSeconds * 1000,
      timeoutMs: opts.timeoutSeconds * 1000,
    },
  );
}

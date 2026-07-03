import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  notify,
  CliError,
  NetworkError,
  UserCancelError,
  UpgradeRequiredError,
  toErrorEnvelope,
  exitCodeFor,
  resolveFormat,
  Formatter,
  type ApiError,
} from '@agenzo/cli-core';

/** code_num is exposed publicly via the error envelope (codeNum() itself is internal). */
function codeNumOf(error: CliError): number {
  return toErrorEnvelope(error).error.code_num;
}

// @inquirer/prompts is mocked so book/cancel never block on a TTY in the
// idempotency-required branches (they run under --yes, so confirm is skipped,
// but the mock guards against accidental prompts).
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import type { ApiClient } from '@agenzo/cli-core';
import { registerQuoteCommand } from '../src/ride-elife/quote.js';
import { registerBookCommand } from '../src/ride-elife/book.js';
import { registerRideGetCommand } from '../src/ride-elife/get.js';
import { registerCancelCommand } from '../src/ride-elife/cancel.js';
import { registerListOrdersCommand } from '../src/ride-elife/list-orders.js';
import { runWatch } from '../src/ride-elife/watch.js';
import { buildProgram, captureStdout, captureStderr, parseJsonOutput, mockApiClient } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// Shared builders / fixtures
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function rideProgram(api: Mock): Command {
  const program = buildProgram();
  const ride = program.command('ride-elife');
  const deps = { apiClient: api as unknown as ApiClient };
  registerQuoteCommand(ride, deps);
  registerBookCommand(ride, deps);
  registerRideGetCommand(ride, deps);
  registerCancelCommand(ride, deps);
  registerListOrdersCommand(ride, deps);
  return program;
}

const BASE = ['node', 'cli', 'ride-elife'];

const QUOTE_RESP = {
  vehicle_classes: [
    { vehicle_class: 'Sedan', price: { amount: 42.5, currency: 'USD', quote_id: 'qte_1' } },
  ],
  is_airport_transfer: false,
};

const quoteArgs = (extra: string[] = []) => [
  ...BASE, 'quote', '--api-key', 'k',
  '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
  '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
  '--pickup-time', 'now',
  ...extra,
];

const bookArgs = (extra: string[] = []) => [
  ...BASE, 'book', '--api-key', 'test-key',
  '--quote-id', 'qte_1', '--vehicle-class', 'Sedan', '--price-amount', '42.50',
  '--passenger-name', 'Alice', '--passenger-phone', '+14155551234',
  ...extra,
];

/** Build a full ApiError from a partial; fromApi only reads code/statusCode/requestId. */
function apiError(partial: Partial<ApiError>): ApiError {
  return {
    success: false,
    errorCode: 0,
    errorMessage: 'backend error',
    statusCode: 500,
    ...partial,
  };
}

// ============================================================
// §6.1 Output-channel purity (TC-CHAN-01..06; Property 1 / Req 5.1)
// ============================================================

describe('§6.1 output-channel purity', () => {
  it('TC-CHAN-01: notify("json", ...) writes nothing to stderr', () => {
    const err = captureStderr();
    notify('json', 'loading', 'Fetching quotes...');
    notify('json', 'success', 'Done');
    expect(err.text()).toBe('');
  });

  it('TC-CHAN-02: notify("table", ...) writes a status line to stderr', () => {
    const err = captureStderr();
    notify('table', 'loading', 'Fetching quotes...');
    expect(err.text()).toContain('Fetching quotes...');
  });

  it('TC-CHAN-03: a networked command in --format json emits one JSON (profile+endpoint) on stdout, clean stderr', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(quoteArgs(['--format', 'json']));

    const payload = parseJsonOutput(out.text()) as Record<string, unknown>;
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');
    expect(payload).toHaveProperty('vehicle_classes');
    // endpoint is host-only (never the internal /api path).
    expect(String(payload.endpoint)).not.toContain('/api/');

    // json mode: stderr carries no status icons nor progress text.
    const stderrText = err.text();
    expect(stderrText).toBe('');
    expect(stderrText).not.toMatch(/[✓ℹ⚠✗]/);
    expect(stderrText).not.toContain('Fetching quotes');
  });

  it('TC-CHAN-04: the same command in --format table puts the spinner on stdout', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(quoteArgs(['--format', 'table']));

    expect(out.text()).toContain('Fetching quotes');
  });

  it('TC-CHAN-05: the watch line stream is NDJSON-only — no profile/endpoint envelope, one compact line per record', async () => {
    const lines: string[] = [];
    const records: unknown[] = [];
    let t = 0;

    await runWatch(
      {
        fetchStatus: vi
          .fn()
          .mockResolvedValueOnce({ status: 'Pending', ride_id: 'r1' })
          .mockResolvedValueOnce({ status: 'At destination', ride_id: 'r1' }),
        writeLine: (record: unknown) => {
          records.push(record);
          lines.push(`${JSON.stringify(record)}\n`);
        },
        sleep: async () => {},
        now: () => (t += 1000),
      },
      { intervalMs: 1000, timeoutMs: 60_000 },
    );

    // Two poll results, each its own line — no timeout line (terminal reached).
    expect(records).toHaveLength(2);
    for (const line of lines) {
      // single compact line, parseable on its own, with a trailing newline.
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
      const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
      // NDJSON stream is NOT wrapped in the renderWithContext envelope.
      expect(parsed).not.toHaveProperty('profile');
      expect(parsed).not.toHaveProperty('endpoint');
    }
    expect((records[1] as { status?: string }).status).toBe('At destination');
  });

  it('TC-CHAN-06: D2 program default — an omitted --format resolves to json (program default value)', () => {
    // NOTE: the shared buildProgram() helper deliberately omits a --format
    // default, so an omitted flag there resolves via resolveFormat(undefined)
    // (AGENZO_FORMAT else table). Production index.ts sets the default to json
    // (D2, agent-first). This test mirrors index.ts's option wiring to assert
    // that program default.
    delete process.env.AGENZO_FORMAT;
    const program = new Command();
    program.exitOverride();
    program.option('--format <format>', 'Output format', 'json');
    let captured: string | undefined;
    program.action(() => {
      captured = program.opts().format as string;
    });
    program.parse(['node', 'cli']);
    expect(captured).toBe('json');
    expect(resolveFormat(captured)).toBe('json');
  });
});

// ============================================================
// §6.2 Idempotency-key required (TC-IDEM-REQ-01..05; Property 3 / Req 5.3)
// ============================================================

describe('§6.2 idempotency-key required on writes', () => {
  it('TC-IDEM-REQ-01: book --yes without --idempotency-key throws PARAM_IDEMPOTENCY_KEY_REQUIRED and sends no request', async () => {
    const api = mockApiClient();
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(bookArgs(['--yes'])),
    ).rejects.toMatchObject({ code: 'PARAM_IDEMPOTENCY_KEY_REQUIRED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-IDEM-REQ-02: cancel --yes without --idempotency-key throws PARAM_IDEMPOTENCY_KEY_REQUIRED and sends no request', async () => {
    const api = mockApiClient();
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'cancel', '--api-key', 'k', '--yes', '--order-id', 'ride_1']),
    ).rejects.toMatchObject({ code: 'PARAM_IDEMPOTENCY_KEY_REQUIRED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-IDEM-REQ-03: a valid key is sent as the Idempotency-Key header, never in the body, and is never auto-generated', async () => {
    const api = mockApiClient({ '/ride/book': { ride_id: 'r1' } });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'book-xyz']));

    const [, , body, headers] = api.post.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(headers).toEqual({ 'Idempotency-Key': 'book-xyz' });
    expect(body).not.toHaveProperty('idempotency_key');
    expect(body).not.toHaveProperty('Idempotency-Key');
  });

  it('TC-IDEM-REQ-04: read-only commands do not declare --idempotency-key (commander rejects the flag)', async () => {
    for (const argv of [
      quoteArgs(['--idempotency-key', 'k']),
      [...BASE, 'get', '--api-key', 'k', '--order-id', 'r1', '--idempotency-key', 'k'],
      [...BASE, 'list-orders', '--api-key', 'k', '--idempotency-key', 'k'],
    ]) {
      const api = mockApiClient();
      const program = rideProgram(api);
      captureStdout();
      captureStderr();
      await expect(program.parseAsync(argv)).rejects.toBeInstanceOf(Error);
      expect(api.post).not.toHaveBeenCalled();
      expect(api.get).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it('TC-IDEM-REQ-05: a malformed key is rejected with PARAM_INVALID before any request', async () => {
    const api = mockApiClient();
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'bad!'])),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// §6.3 Error-code mapping + exit codes (TC-ERR-01..15; Property 4 / Req 5.2, 5.4)
// ============================================================

describe('§6.3 error mapping (CliError.fromApi + exitCodeFor)', () => {
  it('TC-ERR-01: api-key 401 → KEY_INVALID (exit 3)', () => {
    const err = CliError.fromApi(apiError({ statusCode: 401 }), { auth: 'api-key' });
    expect(err.code).toBe('KEY_INVALID');
    expect(exitCodeFor(err)).toBe(3);
  });

  it('TC-ERR-02: api-key 403 → KEY_SCOPE_DENIED (exit 3)', () => {
    const err = CliError.fromApi(apiError({ statusCode: 403 }), { auth: 'api-key' });
    expect(err.code).toBe('KEY_SCOPE_DENIED');
    expect(exitCodeFor(err)).toBe(3);
  });

  it('TC-ERR-03: string code QUOTE_EXPIRED wins over HTTP 410 (D3); code_num 4202, exit 1', () => {
    const err = CliError.fromApi(apiError({ code: 'QUOTE_EXPIRED', statusCode: 410 }), {
      auth: 'api-key',
    });
    expect(err.code).toBe('QUOTE_EXPIRED');
    expect(codeNumOf(err)).toBe(4202);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('TC-ERR-04: string code VEHICLE_UNAVAILABLE wins over HTTP 404 (not RESOURCE_NOT_FOUND); 4201, exit 1', () => {
    const err = CliError.fromApi(apiError({ code: 'VEHICLE_UNAVAILABLE', statusCode: 404 }), {
      auth: 'api-key',
    });
    expect(err.code).toBe('VEHICLE_UNAVAILABLE');
    expect(codeNumOf(err)).toBe(4201);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('TC-ERR-05: BILLING_MODE_MISMATCH string code preserved (3001, exit 1)', () => {
    const err = CliError.fromApi(apiError({ code: 'BILLING_MODE_MISMATCH', statusCode: 400 }));
    expect(err.code).toBe('BILLING_MODE_MISMATCH');
    expect(codeNumOf(err)).toBe(3001);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('TC-ERR-06: PAYMENT_ORDER_NOT_PAID string code preserved (3202, exit 1)', () => {
    const err = CliError.fromApi(apiError({ code: 'PAYMENT_ORDER_NOT_PAID', statusCode: 400 }));
    expect(err.code).toBe('PAYMENT_ORDER_NOT_PAID');
    expect(codeNumOf(err)).toBe(3202);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('TC-ERR-07: ACCOUNT_INSUFFICIENT_BALANCE string code preserved (3103, exit 1)', () => {
    const err = CliError.fromApi(apiError({ code: 'ACCOUNT_INSUFFICIENT_BALANCE' }));
    expect(err.code).toBe('ACCOUNT_INSUFFICIENT_BALANCE');
    expect(codeNumOf(err)).toBe(3103);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('TC-ERR-08: SERVICE_NOT_FOUND (CliError) → 4101, exit 1', () => {
    const err = new CliError('SERVICE_NOT_FOUND', 'nope');
    expect(codeNumOf(err)).toBe(4101);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('TC-ERR-09: PARAM_* codes map to exit 1', () => {
    expect(exitCodeFor(new CliError('PARAM_INVALID', 'x'))).toBe(1);
    expect(exitCodeFor(new CliError('PARAM_IDEMPOTENCY_KEY_REQUIRED', 'x'))).toBe(1);
  });

  it('TC-ERR-10: 429 → RATE_LIMITED (5001, exit 4)', () => {
    const err = CliError.fromApi(apiError({ statusCode: 429 }), { auth: 'api-key' });
    expect(err.code).toBe('RATE_LIMITED');
    expect(codeNumOf(err)).toBe(5001);
    expect(exitCodeFor(err)).toBe(4);
  });

  it('TC-ERR-11: 500 → INTERNAL_ERROR (exit 4) and NetworkError → UPSTREAM_ERROR (exit 4)', () => {
    const internal = CliError.fromApi(apiError({ statusCode: 500 }), { auth: 'api-key' });
    expect(internal.code).toBe('INTERNAL_ERROR');
    expect(exitCodeFor(internal)).toBe(4);

    const network = new NetworkError('https://host', 30_000);
    expect(network.code).toBe('UPSTREAM_ERROR');
    expect(exitCodeFor(network)).toBe(4);
  });

  it('TC-ERR-12: UserCancelError → CLIENT_ABORTED (exit 5)', () => {
    const err = new UserCancelError();
    expect(err.code).toBe('CLIENT_ABORTED');
    expect(exitCodeFor(err)).toBe(5);
  });

  it('TC-ERR-13: UpgradeRequiredError → UPGRADE_REQUIRED (exit 2)', () => {
    const err = new UpgradeRequiredError('0.1.0', '0.2.0', 'npm i -g ...');
    expect(err.code).toBe('UPGRADE_REQUIRED');
    expect(exitCodeFor(err)).toBe(2);
  });

  it('TC-ERR-14: json error envelope is { error:{ code, code_num, message, request_id?, backend_message? } }', () => {
    const withReq = toErrorEnvelope(
      CliError.fromApi(apiError({ statusCode: 401, requestId: 'req-1' }), { auth: 'api-key' }),
    );
    expect(withReq).toEqual({
      error: {
        code: 'KEY_INVALID',
        code_num: 1101,
        message: expect.any(String),
        request_id: 'req-1',
        // apiError()'s errorMessage ('backend error') differs from the stable
        // KEY_INVALID message, so it is surfaced as diagnostic backend_message.
        backend_message: 'backend error',
      },
    });

    // request_id is omitted when the error has none (e.g. local PARAM_INVALID).
    const local = toErrorEnvelope(new CliError('PARAM_INVALID', 'bad input'));
    expect(local.error).not.toHaveProperty('request_id');
    expect(local.error.code).toBe('PARAM_INVALID');
    expect(local.error.code_num).toBe(2101);

    // A single compact JSON line is what the top-level handler writes to stderr.
    const line = JSON.stringify(local);
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual(local);
  });

  it('TC-ERR-15: table error rendering is "✗ [<code_num>] <message>"', () => {
    const env = toErrorEnvelope(new CliError('SERVICE_NOT_FOUND', 'The requested service was not found.'));
    const rendered = Formatter.status('error', `[${env.error.code_num}] ${env.error.message}`);
    expect(rendered).toBe('✗ [4101] The requested service was not found.');
  });
});

// ============================================================
// §6.4 cli-core reuse — static / structural assertions
// (TC-CORE-01..04; Property 6 / Req 4.1, 4.3, 4.4)
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(TEST_DIR, '../src');

/** Recursively collect all .ts source file paths under SRC_DIR. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('§6.4 cli-core reuse (structural)', () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);
  const sources = sourceFiles.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

  it('TC-CORE-01: no local core/ copy exists; shared infra symbols are imported from @agenzo/cli-core', () => {
    // No app-local re-implementation of cli-core infrastructure.
    expect(existsSync(join(SRC_DIR, 'core'))).toBe(false);

    // Spot-check that infra symbols come from @agenzo/cli-core (not a local path).
    const index = sources.find((s) => s.path.endsWith('/index.ts'))!;
    expect(index.text).toMatch(/from\s+['"]@agenzo\/cli-core['"]/);
    for (const symbol of ['ApiClient', 'ConfigManager', 'resolveFormat', 'CliError', 'renderWithContext']) {
      const importsSymbol = sources.some(
        (s) => s.text.includes(symbol) && /from\s+['"]@agenzo\/cli-core['"]/.test(s.text),
      );
      expect(importsSymbol, `${symbol} must be imported from @agenzo/cli-core`).toBe(true);
    }
  });

  it('TC-CORE-02: no source imports any other app (admin-cli / token-cli / payment-cli)', () => {
    for (const { path, text } of sources) {
      expect(text, `${path} must not import another app`).not.toMatch(
        /from\s+['"][^'"]*(admin-cli|token-cli|payment-cli)[^'"]*['"]/,
      );
    }
  });

  it('TC-CORE-03: ride/service response types are defined locally in the app, not pulled from cli-core', () => {
    const responseTypes = [
      'QuoteResponse',
      'BookResponse',
      'GetOrderResponse',
      'CancelResponse',
      'ListOrdersResponse',
    ];
    for (const t of responseTypes) {
      // Single-CLI business types live in their owning app (src/types/api.ts),
      // NOT in @agenzo/cli-core (which only holds cross-CLI shared types).
      const declaredLocally = sources.some((s) =>
        new RegExp(`export\\s+(interface|type)\\s+${t}\\b`).test(s.text),
      );
      expect(declaredLocally, `${t} must be declared locally in merchant-cli`).toBe(true);

      // ...and must NOT be imported from cli-core.
      for (const { path, text } of sources) {
        const importedFromCore = new RegExp(
          `\\{[^}]*\\b${t}\\b[^}]*\\}\\s*from\\s+['"]@agenzo/cli-core['"]`,
        ).test(text);
        expect(importedFromCore, `${t} must not be imported from cli-core in ${path}`).toBe(false);
      }
    }
  });

  it('TC-CORE-04: merchant-domain files stay in the app (not pushed down to cli-core)', () => {
    for (const rel of [
      'idempotency.ts',
      'verb-schema.ts',
      'services/registry.ts',
      'ride-elife/watch.ts',
    ]) {
      expect(existsSync(join(SRC_DIR, rel)), `${rel} must remain in the app`).toBe(true);
    }
  });
});

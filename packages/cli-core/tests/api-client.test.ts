import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiClient,
  DEADLINE_HEADER,
  DEADLINE_RESERVE_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  deadlineFromEnv,
  httpTimeoutFromEnv,
} from '../api-client/client.js';
import type { ApiError, UpstreamError } from '../api-client/client.js';

/**
 * ApiClient.request() error parsing — error_code + data.provider extraction.
 *
 * Validates: Requirements 4.3, 5.2, 5.4
 *
 * These tests verify that the ApiClient correctly:
 * - Prefers string `error_code` over numeric `code` for the ApiError.code field
 * - Extracts `data.upstream` into ApiError.upstream
 * - Handles all combinations of presence/absence gracefully
 */

// Mock the version module to avoid filesystem reads during tests
vi.mock('../version/version.js', () => ({
  getCurrentVersion: () => '0.1.1',
  isBelow: () => false,
  UPGRADE_COMMAND: 'npm install -g agenzo-admin-cli@latest',
}));

let client: ApiClient;

beforeEach(() => {
  client = new ApiClient({ baseUrl: 'https://api.test.com' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: mock global fetch to return a JSON error response. */
function mockFetchJsonError(
  body: Record<string, unknown>,
  status = 400,
): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Bad Request',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  }));
}

describe('ApiClient error_code + data.upstream parsing', () => {
  it('UT-AC-01: error_code present + data.upstream present → code = error_code, upstream populated', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'elife: Person count mismatch',
      data: {
        upstream: {
          code: '400',
          message: 'Person count mismatch',
        },
      },
      request_id: 'req_abc123',
    });

    const result = await client.get('/test', { type: 'none' });
    expect(result.success).toBe(false);

    const err = result as ApiError;
    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toEqual({
      code: '400',
      message: 'Person count mismatch',
    });
    expect(err.requestId).toBe('req_abc123');
    expect(err.errorCode).toBe(1903);
  });

  it('UT-AC-01a: recoverable hotel payment data is preserved', async () => {
    mockFetchJsonError({
      code: '1937',
      error_code: 'PAYORDER_FAILED',
      message: 'Payment failed after the hotel was locked.',
      data: {
        order_id: 'hho_123',
        fc_order_code: 'FC123',
        payment_status: 'FAILED',
      },
    }, 502);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('PAYORDER_FAILED');
    expect(err.data).toEqual({
      order_id: 'hho_123',
      fc_order_code: 'FC123',
      payment_status: 'FAILED',
    });
  });

  it('UT-AC-02: error_code present, NO data.upstream → code = error_code, upstream = undefined', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: null,
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-03: NO error_code, data.upstream present → code = numeric code string, upstream populated', async () => {
    mockFetchJsonError({
      code: '1903',
      message: 'elife: Person count mismatch',
      data: {
        upstream: {
          code: '400',
          message: 'Person count mismatch',
        },
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // Falls back to numeric code string since no error_code
    expect(err.code).toBe('1903');
    expect(err.upstream).toEqual({
      code: '400',
      message: 'Person count mismatch',
    });
  });

  it('UT-AC-04: neither error_code nor data.upstream → existing fallback behavior', async () => {
    mockFetchJsonError({
      code: '1903',
      message: 'Something went wrong',
      data: null,
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // Falls back to numeric code string
    expect(err.code).toBe('1903');
    expect(err.upstream).toBeUndefined();
    expect(err.errorCode).toBe(1903);
  });

  it('UT-AC-05: error_code takes priority over numeric code → ApiError.code = error_code string', async () => {
    mockFetchJsonError({
      code: '1901',
      error_code: 'VEHICLE_UNAVAILABLE',
      message: 'No vehicle available',
      data: {
        upstream: {
          code: '404',
          message: 'No vehicle found in area',
        },
      },
    }, 404);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // error_code wins over numeric code "1901"
    expect(err.code).toBe('VEHICLE_UNAVAILABLE');
    expect(err.errorCode).toBe(1901);
    expect(err.statusCode).toBe(404);
  });

  it('UT-AC-06: data.upstream is not an object (string) → upstream = undefined (graceful degradation)', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: {
        upstream: 'invalid',
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    // Non-object upstream is ignored gracefully
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-07: data.upstream is null → upstream = undefined', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: {
        upstream: null,
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-08: data.upstream is a number → upstream = undefined', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: 'BOOKING_FAILED',
      message: 'Booking failed',
      data: {
        upstream: 42,
      },
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('BOOKING_FAILED');
    expect(err.upstream).toBeUndefined();
  });

  it('UT-AC-09: code "0000" with HTTP error status still treated as error', async () => {
    // Edge case: HTTP 500 but code = "0000" — response.ok is false so it's an error
    mockFetchJsonError({
      code: '0000',
      message: 'Internal error',
      data: null,
    }, 500);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // "0000" parses to 0, but code string is "0000" which is truthy
    expect(err.success).toBe(false);
    expect(err.statusCode).toBe(500);
  });

  it('UT-AC-10: error_code is empty string → falls back to numeric code', async () => {
    mockFetchJsonError({
      code: '1903',
      error_code: '',
      message: 'Some error',
      data: null,
    });

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    // Empty string is falsy, so errorCodeStr check fails → falls back to code
    expect(err.code).toBe('1903');
  });

  it('UT-AC-11: 5xx status with error_code + upstream → all fields correctly populated', async () => {
    mockFetchJsonError({
      code: '5101',
      error_code: 'UPSTREAM_ERROR',
      message: 'elife: timeout',
      data: {
        upstream: {
          code: 'NETWORK_ERROR',
          message: 'Connection timeout after 30s',
        },
      },
      request_id: 'req_xyz789',
    }, 502);

    const result = await client.get('/test', { type: 'none' });
    const err = result as ApiError;

    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.statusCode).toBe(502);
    expect(err.errorCode).toBe(5101);
    expect(err.upstream).toEqual({
      code: 'NETWORK_ERROR',
      message: 'Connection timeout after 30s',
    });
    expect(err.requestId).toBe('req_xyz789');
  });
});

/** Helper: mock global fetch to return a JSON success response. */
function mockFetchJsonSuccess(
  body: Record<string, unknown>,
  status = 200,
): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  }));
}

describe('ApiClient success payload unwrapping', () => {
  it('UT-AC-11: data field present and null → payload is null (not the envelope)', async () => {
    // Regression: `data ?? responseBody` previously fell back to the whole
    // envelope when data was null (e.g. GET /accounts with no settlement
    // account), surfacing { code, message, data: null } as the payload and
    // breaking downstream null-checks. Must return null.
    mockFetchJsonSuccess({
      code: '0000',
      message: 'No settlement account found for this developer.',
      data: null,
    });

    const result = await client.get('/accounts', { type: 'none' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
      expect(result.message).toBe('No settlement account found for this developer.');
    }
  });

  it('UT-AC-12: data field present with object → payload is the unwrapped object', async () => {
    mockFetchJsonSuccess({
      code: '0000',
      message: 'ok',
      data: { id: 'acct_1', balance: 100 },
    });

    const result = await client.get('/accounts', { type: 'none' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: 'acct_1', balance: 100 });
    }
  });

  it('UT-AC-13: no data field (raw response) → payload is the whole body', async () => {
    mockFetchJsonSuccess({ status: 'CONSUMED', token: 'abc' });

    const result = await client.get('/raw', { type: 'none' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ status: 'CONSUMED', token: 'abc' });
    }
  });
});

/**
 * traceparent 续链 — orchestrator 以子进程调用 CLI 时经 TRACEPARENT 环境变量传递
 * W3C trace 上下文，CLI 必须转发为请求头，否则链路在 CLI 这一跳断开。
 */
describe('ApiClient traceparent forwarding', () => {
  const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  /** Helper: 捕获实际发出的请求头。 */
  function mockFetchCapturingHeaders(): { headers: () => Record<string, string> } {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ code: '0', message: 'ok', data: {} }),
    });
    vi.stubGlobal('fetch', spy);
    return {
      headers: () =>
        (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>,
    };
  }

  afterEach(() => {
    delete process.env.TRACEPARENT;
  });

  it('forwards a valid TRACEPARENT env var as the traceparent header', async () => {
    process.env.TRACEPARENT = VALID;
    const captured = mockFetchCapturingHeaders();

    await client.get('/v1/ping', { type: 'none' });

    expect(captured.headers()['traceparent']).toBe(VALID);
    // X-Request-Id 仍是本次 CLI 调用自己的关联 id，与 trace 串联互不干扰
    expect(captured.headers()['X-Request-Id']).toBeTruthy();
  });

  it('trims surrounding whitespace before forwarding', async () => {
    process.env.TRACEPARENT = `  ${VALID}  `;
    const captured = mockFetchCapturingHeaders();

    await client.get('/v1/ping', { type: 'none' });

    expect(captured.headers()['traceparent']).toBe(VALID);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['malformed', 'garbage'],
    ['wrong trace-id length', '00-abc-00f067aa0ba902b7-01'],
    ['missing flags', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'],
  ])('does not send the header when TRACEPARENT is %s', async (_label, value) => {
    if (value === undefined) {
      delete process.env.TRACEPARENT;
    } else {
      process.env.TRACEPARENT = value;
    }
    const captured = mockFetchCapturingHeaders();

    await client.get('/v1/ping', { type: 'none' });

    expect(captured.headers()['traceparent']).toBeUndefined();
  });
});

/**
 * HTTP 超时可配 — 递减 deadline 的前置。
 *
 * 此前超时恒为 60s：四个 app 入口都没传 timeout，也没有任何环境变量入口，
 * 调用方无法覆盖。deadline 传播要求上游能按剩余预算压缩本跳超时，值传下来
 * 却没地方生效就没有意义。
 */
describe('ApiClient HTTP timeout configuration', () => {
  afterEach(() => {
    delete process.env.AGENZO_CLI_HTTP_TIMEOUT_MS;
  });

  /** 读取实例上生效的超时值（private 字段，测试里按运行时结构取）。 */
  function effectiveTimeout(c: ApiClient): number {
    return (c as unknown as { timeout: number }).timeout;
  }

  it('falls back to the documented default', () => {
    expect(effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }))).toBe(
      DEFAULT_HTTP_TIMEOUT_MS,
    );
    // 写死具体数字是刻意的：本项是跨服务超时阶梯的一层（App 120s > orchestrator
    // 90s > 本项 70s > provider 45s），单独调会破坏层级余量，所以必须连带改测试，
    // 逼调整成为有意识的决定。也顺带防住"注释与代码漂移"（曾注释 30000 而代码 60000）。
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(70000);
  });

  it('reads AGENZO_CLI_HTTP_TIMEOUT_MS', () => {
    process.env.AGENZO_CLI_HTTP_TIMEOUT_MS = '15000';

    expect(effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }))).toBe(15000);
  });

  it('lets an explicit config value win over the env var', () => {
    process.env.AGENZO_CLI_HTTP_TIMEOUT_MS = '15000';

    // 调用方对单个 client 做例外（如长轮询）不应被进程级设置牵连
    expect(
      effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com', timeout: 90000 })),
    ).toBe(90000);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a number', 'soon'],
    ['zero', '0'],
    ['negative', '-1'],
    ['infinity', 'Infinity'],
  ])('ignores a %s env value and uses the default', (_label, value) => {
    process.env.AGENZO_CLI_HTTP_TIMEOUT_MS = value;

    expect(effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }))).toBe(
      DEFAULT_HTTP_TIMEOUT_MS,
    );
  });

  it('parses the env var without touching process.env', () => {
    expect(httpTimeoutFromEnv({ AGENZO_CLI_HTTP_TIMEOUT_MS: '2500' })).toBe(2500);
    expect(httpTimeoutFromEnv({})).toBeNull();
  });
});

/**
 * 递减 deadline — 链路第三跳。
 *
 * orchestrator 经 DEADLINE_MS 环境变量把剩余预算交给本进程（与 TRACEPARENT 同一
 * 机制），本进程据此压缩自己的 HTTP 超时，并把扣掉自身耗时后的余量作为
 * X-Deadline-Ms 传给 platform。
 */
describe('ApiClient deadline propagation', () => {
  const originalDeadline = process.env.DEADLINE_MS;

  afterEach(() => {
    if (originalDeadline === undefined) {
      delete process.env.DEADLINE_MS;
    } else {
      process.env.DEADLINE_MS = originalDeadline;
    }
    delete process.env.AGENZO_CLI_HTTP_TIMEOUT_MS;
  });

  function effectiveTimeout(c: ApiClient): number {
    return (c as unknown as { timeout: number }).timeout;
  }

  function mockFetchCapturingHeaders() {
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: '0', message: 'ok', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    return {
      headers: () => (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>,
    };
  }

  describe('parsing DEADLINE_MS', () => {
    it('reads a positive integer', () => {
      expect(deadlineFromEnv({ DEADLINE_MS: '5000' })).toBe(5000);
    });

    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['not a number', 'soon'],
      ['zero', '0'],
      ['negative', '-1'],
      ['float', '1500.5'],
      ['scientific', '1e3'],
    ])('treats a %s value as unset', (_label, value) => {
      // 拒浮点串是刻意的：协议规定整数毫秒，容忍浮点会让不同语言的实现取整分歧
      expect(deadlineFromEnv(value === undefined ? {} : { DEADLINE_MS: value })).toBeNull();
    });
  });

  describe('shrinking our own timeout', () => {
    it('a tight budget wins over the configured timeout', () => {
      process.env.DEADLINE_MS = '3000';

      const timeout = effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }));

      expect(timeout).toBeLessThanOrEqual(3000 - DEADLINE_RESERVE_MS);
    });

    it('an ample budget does not raise the configured timeout', () => {
      // 预算代表上游还愿意等多久，本跳没有权限超出自己的配置上限
      process.env.DEADLINE_MS = '600000';

      expect(effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }))).toBe(
        DEFAULT_HTTP_TIMEOUT_MS,
      );
    });

    it('never yields a non-positive timeout', () => {
      // 预算已小于回程预留时，超时不能变成 0 或负数（那会让请求立刻 abort）
      process.env.DEADLINE_MS = '50';

      expect(effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }))).toBeGreaterThan(
        0,
      );
    });

    it('leaves the timeout alone when no budget is injected', () => {
      delete process.env.DEADLINE_MS;

      expect(effectiveTimeout(new ApiClient({ baseUrl: 'https://api.test.com' }))).toBe(
        DEFAULT_HTTP_TIMEOUT_MS,
      );
    });
  });

  describe('forwarding to platform', () => {
    it('sends the remaining budget as X-Deadline-Ms', async () => {
      process.env.DEADLINE_MS = '30000';
      const client = new ApiClient({ baseUrl: 'https://api.test.com' });
      const captured = mockFetchCapturingHeaders();

      await client.get('/v1/ping', { type: 'none' });

      const sent = Number(captured.headers()[DEADLINE_HEADER]);
      expect(sent).toBeGreaterThan(0);
      // 必须严格小于收到的量：扣掉本进程已用时间与回程预留
      expect(sent).toBeLessThanOrEqual(30000 - DEADLINE_RESERVE_MS);
    });

    it('omits the header when no budget is injected', async () => {
      delete process.env.DEADLINE_MS;
      const client = new ApiClient({ baseUrl: 'https://api.test.com' });
      const captured = mockFetchCapturingHeaders();

      await client.get('/v1/ping', { type: 'none' });

      expect(captured.headers()[DEADLINE_HEADER]).toBeUndefined();
    });

    it('still sends 0 once the budget is spent', async () => {
      // 发 0 而不是省略：让下游立刻返回 DEADLINE_EXCEEDED，而不是白跑一趟才超时
      process.env.DEADLINE_MS = '1';
      const client = new ApiClient({ baseUrl: 'https://api.test.com' });
      const captured = mockFetchCapturingHeaders();

      await client.get('/v1/ping', { type: 'none' });

      expect(captured.headers()[DEADLINE_HEADER]).toBe('0');
    });

    it('does not disturb the existing trace and request id headers', async () => {
      process.env.DEADLINE_MS = '30000';
      const client = new ApiClient({ baseUrl: 'https://api.test.com' });
      const captured = mockFetchCapturingHeaders();

      await client.get('/v1/ping', { type: 'none' });

      expect(captured.headers()['X-Request-Id']).toBeTruthy();
      expect(captured.headers()[DEADLINE_HEADER]).toBeTruthy();
    });
  });

  it('uses the same header name as py-commons', () => {
    // 六仓必须对头名一致，写错一个字母就是静默断链
    expect(DEADLINE_HEADER).toBe('x-deadline-ms');
  });
});

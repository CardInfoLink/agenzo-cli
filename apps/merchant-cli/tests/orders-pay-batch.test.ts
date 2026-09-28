/**
 * orders pay-batch —— 行程聚合支付命令的示例测试（spec trip-aggregate-payment 任务 7.3）。
 *
 * 被测对象：`src/orders/pay-batch.ts` 的 `registerOrdersPayBatchCommand` /
 * `parseOrderIds` / `isBatchTerminal` / `PAY_BATCH_TERMINAL_STATUSES`，以及注册到
 * `orders` 命令组（见 `src/index.ts`）。测试沿用 merchant-cli 既有 commander +
 * helpers.mockApiClient 基建（与 hotel-create-pay / ride-create-pay 同构）：真实
 * `parseAsync` 驱动 commander，注入 mock ApiClient，断言请求路径 / auth / header / body /
 * 输出，`--yes` 跳过确认、`--watch` NDJSON 轮询到终态。
 *
 * 覆盖（对应任务 7.3 要求）：
 *   - 单发成功：POST /orders/pay-batch、Idempotency-Key header、body 结构、--yes 跳过确认、成功体渲染；
 *   - parseOrderIds：逗号分隔与 JSON 数组两种写法、保序、拒空/非法 → PARAM_INVALID（单元 + 属性）；
 *   - 3DS 挑战体（AUTHENTICATION_REQUIRED）与 4xx 业务错误（不可支付单）的处理/退出码；
 *   - --watch：轮询到终态（settled/partially_settled/failed）输出 NDJSON、isBatchTerminal 判定（单元 + 属性）；
 *   - 混合三域 order_ids 透传。
 *
 * **Validates: Requirements 11.1**
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fc from 'fast-check';
import { CliError, exitCodeFor } from '@agenzo/cli-core';
import type { ApiClient } from '@agenzo/cli-core';

// @inquirer/prompts 被 mock：非 `--yes` 分支的 confirm 无需 TTY 即可驱动；`--yes` 路径
// 跳过 confirm。PromptEngine.resolveInput 在传入 --api-key 时直接返回该值，password/input
// 不会被触达。
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));
import { confirm } from '@inquirer/prompts';

import {
  registerOrdersPayBatchCommand,
  parseOrderIds,
  isBatchTerminal,
  PAY_BATCH_TERMINAL_STATUSES,
} from '../src/orders/pay-batch.js';
import { buildProgram, captureStdout, captureStderr, parseJsonOutput, mockApiClient } from './helpers.js';

const confirmMock = vi.mocked(confirm);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

beforeEach(() => {
  confirmMock.mockReset();
});

// ============================================================
// Response fixtures（十进制金额，非最小单位；order_id 可混合 hho_/ffo_/rio_ 三域）
// ============================================================

/** 双轨全额结算成功：settled，携合计总额 + 币种 + 逐单确认结果（逐单键 per_order、含 domain）。 */
const SETTLED_RESP = {
  payment_group_id: 'pg_1',
  status: 'settled',
  currency: 'CNY',
  total_amount: 1180,
  per_order: [
    { order_id: 'hho_1', domain: 'hotel', status: 'confirmed', amount: 640 },
    { order_id: 'ffo_2', domain: 'flight', status: 'confirmed', amount: 500 },
    { order_id: 'rio_3', domain: 'ride', status: 'confirmed', amount: 40 },
  ],
};

/** 部分失败补偿：partially_settled，失败单已按其金额退款。 */
const PARTIALLY_SETTLED_RESP = {
  payment_group_id: 'pg_2',
  status: 'partially_settled',
  currency: 'CNY',
  total_amount: 1180,
  per_order: [
    { order_id: 'hho_1', domain: 'hotel', status: 'confirmed', amount: 640 },
    { order_id: 'ffo_2', domain: 'flight', status: 'refunded', amount: 500, refunded_amount: 500 },
  ],
};

/** 轨 B EVO 强制认证：一趟一次 3DS 挑战体（HTTP 200 成功体，非 4xx）。 */
const CHALLENGE_RESP = {
  payment_group_id: 'pg_3',
  status: 'AUTHENTICATION_REQUIRED',
  currency: 'CNY',
  amount: 1180,
  three_ds_url: 'https://evo.example/3ds/challenge/abc',
  merchant_trans_id: 'mt_evo_1',
};

// ============================================================
// Program builder（挂载到 orders 命令组，与 index.ts 注册处一致）
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function ordersProgram(apiClient: Mock) {
  const program = buildProgram();
  const orders = program.command('orders');
  const deps = { apiClient: apiClient as unknown as ApiClient };
  registerOrdersPayBatchCommand(orders, deps);
  return program;
}

const BASE = ['node', 'cli', 'orders'];

// ============================================================
// parseOrderIds —— 解析/保序/校验（单元）
// ============================================================

/** 断言 fn 抛出 code=PARAM_INVALID 的 CliError（且确实抛出）。 */
function expectParamInvalid(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe('PARAM_INVALID');
}

describe('parseOrderIds', () => {
  it('逗号分隔：保序解析为非空列表（可混合三域）', () => {
    expect(parseOrderIds('hho_1,ffo_2,rio_3')).toEqual(['hho_1', 'ffo_2', 'rio_3']);
  });

  it('JSON 数组字符串：保序解析为非空列表', () => {
    expect(parseOrderIds('["hho_1","ffo_2","rio_3"]')).toEqual(['hho_1', 'ffo_2', 'rio_3']);
  });

  it('逗号分隔：去除每项首尾空白，并丢弃尾随逗号产生的空片段', () => {
    expect(parseOrderIds(' hho_1 , ffo_2 ,rio_3, ')).toEqual(['hho_1', 'ffo_2', 'rio_3']);
  });

  it('JSON 数组：对每项 trim', () => {
    expect(parseOrderIds('[" hho_1 ", "ffo_2"]')).toEqual(['hho_1', 'ffo_2']);
  });

  it('空字符串 → PARAM_INVALID', () => {
    expectParamInvalid(() => parseOrderIds(''));
  });

  it('纯空白 → PARAM_INVALID', () => {
    expectParamInvalid(() => parseOrderIds('   '));
  });

  it('仅逗号（全空片段）→ PARAM_INVALID', () => {
    expectParamInvalid(() => parseOrderIds(',, ,'));
  });

  it('空 JSON 数组 [] → PARAM_INVALID', () => {
    expectParamInvalid(() => parseOrderIds('[]'));
  });

  it('非法 JSON（以 [ 开头但无法解析）→ PARAM_INVALID', () => {
    expectParamInvalid(() => parseOrderIds('["hho_1", '));
  });

  it('JSON 数组含非字符串元素 → PARAM_INVALID', () => {
    expectParamInvalid(() => parseOrderIds('["hho_1", 42]'));
  });
});

// ============================================================
// parseOrderIds —— 属性测试（保序、两种写法等价）
// ============================================================

describe('parseOrderIds (property)', () => {
  // 安全的 order_id 片段：非空、无逗号/中括号/空白，避免被误判为 JSON 或产生空片段。
  const idToken = fc
    .stringMatching(/^[A-Za-z0-9_-]+$/)
    .filter((s) => s.length > 0 && s.length <= 24);

  // Feature: trip-aggregate-payment, Property (CLI 7.3): 逗号分隔写法保序无损
  it('逗号分隔：解析结果与输入 token 列表逐一保序相等', () => {
    fc.assert(
      fc.property(fc.array(idToken, { minLength: 1, maxLength: 8 }), (tokens) => {
        expect(parseOrderIds(tokens.join(','))).toEqual(tokens);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: trip-aggregate-payment, Property (CLI 7.3): JSON 数组写法保序无损
  it('JSON 数组：解析结果与输入 token 列表逐一保序相等', () => {
    fc.assert(
      fc.property(fc.array(idToken, { minLength: 1, maxLength: 8 }), (tokens) => {
        expect(parseOrderIds(JSON.stringify(tokens))).toEqual(tokens);
      }),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// isBatchTerminal —— 终态判定（单元 + 属性）
// ============================================================

describe('isBatchTerminal', () => {
  it('settled / partially_settled / failed 为终态', () => {
    expect(isBatchTerminal({ status: 'settled' })).toBe(true);
    expect(isBatchTerminal({ status: 'partially_settled' })).toBe(true);
    expect(isBatchTerminal({ status: 'failed' })).toBe(true);
  });

  it('AUTHENTICATION_REQUIRED / authorizing 等非终态', () => {
    expect(isBatchTerminal({ status: 'AUTHENTICATION_REQUIRED' })).toBe(false);
    expect(isBatchTerminal({ status: 'authorizing' })).toBe(false);
    expect(isBatchTerminal({ status: 'AUTHORIZED' })).toBe(false);
  });

  it('缺失/非字符串 status 永不终态（记录体恒为响应对象）', () => {
    expect(isBatchTerminal({})).toBe(false);
    expect(isBatchTerminal({ status: 123 })).toBe(false);
    expect(isBatchTerminal({ status: null })).toBe(false);
  });

  // Feature: trip-aggregate-payment, Property (CLI 7.3): 终态判定当且仅当 status ∈ 终态集合
  it('任意字符串 status：终态当且仅当命中 PAY_BATCH_TERMINAL_STATUSES', () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        expect(isBatchTerminal({ status })).toBe(PAY_BATCH_TERMINAL_STATUSES.has(status));
      }),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// 单发成功 —— POST /orders/pay-batch、header、body、--yes 跳过确认、渲染
// ============================================================

describe('orders pay-batch —— 单发成功', () => {
  const args = (extra: string[] = []) => [
    ...BASE, 'pay-batch', '--api-key', 'k',
    '--order-ids', 'hho_1,ffo_2,rio_3',
    ...extra,
  ];

  it('成功 → exit 0，POST /orders/pay-batch；order_ids 保序进 body、payment_token_id 进 body；Idempotency-Key 走 header；--yes 跳过确认；渲染成功体', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(args([
      '--payment-token-id', 'ntk_1',
      '--idempotency-key', 'trip-pay-1',
      '--yes', '--format', 'json',
    ]));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [
      string, unknown, Record<string, any>, Record<string, string>,
    ];
    expect(path).toBe('/orders/pay-batch');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });

    // order_ids 保序、可混合三域；轨 A 令牌进 body。
    expect(body.order_ids).toEqual(['hho_1', 'ffo_2', 'rio_3']);
    expect(body.payment_token_id).toBe('ntk_1');
    // 未提供的可选字段一律不出现。
    expect(body).not.toHaveProperty('payment_method_id');
    expect(body).not.toHaveProperty('evo_explicit');
    expect(body).not.toHaveProperty('payment_group_id');
    expect(body).not.toHaveProperty('member_id');
    // 调用方不传各订单金额（合计由后端按权威价求和）。
    expect(body).not.toHaveProperty('total_amount');
    expect(body).not.toHaveProperty('amount');

    // Idempotency-Key 走 header，绝不进 body。
    expect(headers).toEqual({ 'Idempotency-Key': 'trip-pay-1' });
    expect(body).not.toHaveProperty('idempotency_key');
    expect(body).not.toHaveProperty('Idempotency-Key');

    // --yes 跳过二次确认。
    expect(confirmMock).not.toHaveBeenCalled();

    // 成功体渲染：合计总额 + 币种 + 逐单确认结果。
    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.payment_group_id).toBe('pg_1');
    expect(payload.status).toBe('settled');
    expect(payload.total_amount).toBe(1180);
    expect(payload.currency).toBe('CNY');
    expect(payload.per_order).toHaveLength(3);
    expect(payload.per_order[0]).toMatchObject({ order_id: 'hho_1', domain: 'hotel', status: 'confirmed', amount: 640 });
  });

  it('JSON 数组写法的 --order-ids 同样保序进 body（混合三域透传）', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'pay-batch', '--api-key', 'k',
      '--order-ids', '["ffo_9","hho_8","rio_7"]',
      '--payment-token-id', 'ntk_1',
      '--idempotency-key', 'trip-pay-json',
      '--yes', '--format', 'json',
    ]);

    const [, , body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    // 顺序即用户表述顺序，CLI 不重排、不校验前缀域。
    expect(body.order_ids).toEqual(['ffo_9', 'hho_8', 'rio_7']);
  });

  it('轨 B：--payment-method-id + --evo-explicit → body 携 payment_method_id 与 evo_explicit=true', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(args([
      '--payment-method-id', 'pm_evo_1',
      '--evo-explicit',
      '--idempotency-key', 'trip-pay-evo',
      '--yes', '--format', 'json',
    ]));

    const [, , body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(body.payment_method_id).toBe('pm_evo_1');
    expect(body.evo_explicit).toBe(true);
    expect(body).not.toHaveProperty('payment_token_id');
  });

  it('未传 --evo-explicit 时 body 不含 evo_explicit（后端默认 false）', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(args([
      '--payment-method-id', 'pm_evo_1',
      '--idempotency-key', 'trip-pay-noevo',
      '--yes', '--format', 'json',
    ]));

    const [, , body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(body).not.toHaveProperty('evo_explicit');
  });

  it('--payment-group-id 与 --member 仅在提供时进 body', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(args([
      '--payment-token-id', 'ntk_1',
      '--payment-group-id', 'pg_pre_1',
      '--member', 'm_1',
      '--idempotency-key', 'trip-pay-grp',
      '--yes', '--format', 'json',
    ]));

    const [, , body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(body.payment_group_id).toBe('pg_pre_1');
    expect(body.member_id).toBe('m_1');
  });

  it('缺 --order-ids → PARAM_INVALID，不发请求', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'pay-batch', '--api-key', 'k',
        '--idempotency-key', 'trip-pay-noids', '--yes',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('--yes 下缺 --idempotency-key → PARAM_IDEMPOTENCY_KEY_REQUIRED，不发请求', async () => {
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(args(['--payment-token-id', 'ntk_1', '--yes'])),
    ).rejects.toMatchObject({ code: 'PARAM_IDEMPOTENCY_KEY_REQUIRED' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// 二次确认门 —— 非 --yes 路径（这是真正动钱的一步）
// ============================================================

describe('orders pay-batch —— 写前二次确认', () => {
  const args = (extra: string[] = []) => [
    ...BASE, 'pay-batch', '--api-key', 'k',
    '--order-ids', 'hho_1,ffo_2',
    '--payment-token-id', 'ntk_1',
    '--idempotency-key', 'trip-confirm',
    ...extra,
  ];

  it('未加 --yes 且用户确认 → 命中确认门后 POST 一次', async () => {
    confirmMock.mockResolvedValue(true);
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(args(['--format', 'json']));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('未加 --yes 且用户拒绝 → CLIENT_ABORTED（exit 5）、不发请求', async () => {
    confirmMock.mockResolvedValue(false);
    const api = mockApiClient({ '/orders/pay-batch': SETTLED_RESP });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    let err: unknown;
    try {
      await program.parseAsync(args([]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('CLIENT_ABORTED');
    expect(exitCodeFor(err as CliError)).toBe(5);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// 3DS 挑战体 —— AUTHENTICATION_REQUIRED（HTTP 200 成功体，薄透传渲染）
// ============================================================

describe('orders pay-batch —— 3DS 挑战体', () => {
  it('单发返回 AUTHENTICATION_REQUIRED → exit 0，原样透出 three_ds_url / merchant_trans_id / 挑战金额', async () => {
    const api = mockApiClient({ '/orders/pay-batch': CHALLENGE_RESP });
    const program = ordersProgram(api);
    const out = captureStdout();
    captureStderr();

    // 成功体（success=true）→ 不抛错、exit 0。
    await program.parseAsync([
      ...BASE, 'pay-batch', '--api-key', 'k',
      '--order-ids', 'hho_1,ffo_2',
      '--payment-method-id', 'pm_evo_1', '--evo-explicit',
      '--idempotency-key', 'trip-3ds', '--yes', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.status).toBe('AUTHENTICATION_REQUIRED');
    expect(payload.three_ds_url).toBe('https://evo.example/3ds/challenge/abc');
    expect(payload.merchant_trans_id).toBe('mt_evo_1');
    expect(payload.amount).toBe(1180);
  });
});

// ============================================================
// 4xx 业务错误 —— 不可支付单等（success=false → 抛错 exit 1）
// ============================================================

describe('orders pay-batch —— 4xx 业务错误', () => {
  it('不可支付单（422 ORDER_NOT_PAYABLE，非目录码）→ 映射 PARAM_INVALID（exit 1）', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 0,
      errorMessage: 'hho_2 is not in AWAITING_PAYMENT',
      statusCode: 422,
      code: 'ORDER_NOT_PAYABLE',
      data: { order_id: 'hho_2' },
    });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    let err: unknown;
    try {
      await program.parseAsync([
        ...BASE, 'pay-batch', '--api-key', 'k',
        '--order-ids', 'hho_1,hho_2',
        '--payment-token-id', 'ntk_1',
        '--idempotency-key', 'trip-nonpayable', '--yes', '--format', 'json',
      ]);
    } catch (e) {
      err = e;
    }
    // ORDER_NOT_PAYABLE 不在 §8 目录码中 → fromApi 按 HTTP 422 回退到 PARAM_INVALID。
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('PARAM_INVALID');
    expect(exitCodeFor(err as CliError)).toBe(1);
    // 后端在错误 data 中标明具体 order_id，透传保留。
    expect((err as CliError).data).toMatchObject({ order_id: 'hho_2' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('令牌绑定不符（409 RESOURCE_CONFLICT 目录码）→ 保留原码（exit 1）', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 0,
      errorMessage: 'token external_transaction_id not bound to this payment_group',
      statusCode: 409,
      code: 'RESOURCE_CONFLICT',
    });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'pay-batch', '--api-key', 'k',
        '--order-ids', 'hho_1,ffo_2',
        '--payment-token-id', 'ntk_wrong',
        '--idempotency-key', 'trip-mismatch', '--yes', '--format', 'json',
      ]),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// --watch —— NDJSON 轮询到终态 / 超时 / 业务错误
// ============================================================

describe('orders pay-batch --watch', () => {
  const watchArgs = (extra: string[] = []) => [
    ...BASE, 'pay-batch', '--api-key', 'k',
    '--order-ids', 'hho_1,ffo_2,rio_3',
    '--payment-token-id', 'ntk_1',
    '--idempotency-key', 'trip-watch',
    '--watch', '--yes', '--format', 'json',
    ...extra,
  ];

  it('非终态（AUTHENTICATION_REQUIRED / authorizing）持续轮询，直到 settled 终态；每次轮询输出一行 NDJSON', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const api = mockApiClient();
    api.post.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        // 首轮 EVO 强制认证：非终态，继续轮询（用户外带完成 3DS 后幂等重放结算）。
        return Promise.resolve({ success: true, data: CHALLENGE_RESP });
      }
      if (callCount === 2) {
        return Promise.resolve({ success: true, data: { payment_group_id: 'pg_1', status: 'authorizing' } });
      }
      // 第三轮到达终态 settled。
      return Promise.resolve({ success: true, data: SETTLED_RESP });
    });

    const program = ordersProgram(api);
    const out = captureStdout();
    captureStderr();

    const parsePromise = program.parseAsync(watchArgs(['--watch-interval', '1', '--watch-timeout', '60']));

    // 推进假时钟让 realSleep 逐次 resolve。
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    await parsePromise;
    vi.useRealTimers();

    // 幂等重放同一批次共轮询 3 次（每次 body/header 一致）。
    expect(api.post).toHaveBeenCalledTimes(3);
    const [, , body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(body.order_ids).toEqual(['hho_1', 'ffo_2', 'rio_3']);
    expect(headers).toEqual({ 'Idempotency-Key': 'trip-watch' });

    // 每轮一行 NDJSON。
    const lines = out.text().trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).status).toBe('AUTHENTICATION_REQUIRED');
    expect(JSON.parse(lines[1]).status).toBe('authorizing');
    const last = JSON.parse(lines[2]);
    expect(last.status).toBe('settled');
    expect(isBatchTerminal(last)).toBe(true);
    // --yes 下确认被跳过。
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('partially_settled 亦为终态：一轮即停，输出该行 NDJSON', async () => {
    const api = mockApiClient({ '/orders/pay-batch': PARTIALLY_SETTLED_RESP });
    const program = ordersProgram(api);
    const out = captureStdout();
    captureStderr();

    // interval 极大、timeout 相对小，但首轮即终态 → 立即停止（无需真实 sleep）。
    await program.parseAsync(watchArgs(['--watch-interval', '999', '--watch-timeout', '600']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const lines = out.text().trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.status).toBe('partially_settled');
    expect(isBatchTerminal(rec)).toBe(true);
    // 无 timeout 行。
    expect(rec.watch_status).toBeUndefined();
  });

  it('始终未达终态 → 最后一行为 timeout', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({ success: true, data: { payment_group_id: 'pg_1', status: 'authorizing' } });
    const program = ordersProgram(api);
    const out = captureStdout();
    captureStderr();

    // interval 999s、timeout 1s：首轮写行后，下一轮将越过截止 → 立即收尾输出 timeout 行。
    await program.parseAsync(watchArgs(['--watch-interval', '999', '--watch-timeout', '1']));

    expect(api.post.mock.calls.length).toBeGreaterThanOrEqual(1);
    const lines = out.text().trim().split('\n').filter(Boolean);
    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.watch_status).toBe('timeout');
  });

  it('轮询期间业务错误（success=false）→ 直接抛错 exit 1', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 0,
      errorMessage: 'currency mismatch across order_ids',
      statusCode: 422,
      code: 'CURRENCY_MISMATCH',
    });
    const program = ordersProgram(api);
    captureStdout();
    captureStderr();

    let err: unknown;
    try {
      await program.parseAsync(watchArgs(['--watch-interval', '999', '--watch-timeout', '10']));
    } catch (e) {
      err = e;
    }
    // CURRENCY_MISMATCH 非目录码 → 422 回退 PARAM_INVALID（exit 1）。
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('PARAM_INVALID');
    expect(exitCodeFor(err as CliError)).toBe(1);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

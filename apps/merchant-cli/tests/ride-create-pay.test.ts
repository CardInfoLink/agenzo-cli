/**
 * Tests for ride-elife create-order 与 pay-order CLI 两步命令
 * （ride-network-token-direct-charge 任务 10.4）。
 *
 * 覆盖网络令牌直扣两步主路径的 CLI 透传契约：
 *   - create-order（R11.1）：POST /ride/create-order 锁单成功后输出 order_ref +
 *     权威金额/币种；Idempotency-Key 走 header（绝不进 body）；body 不携带任何
 *     支付凭证（锁单不碰钱）。
 *   - pay-order（R11.2）：--payment-token-id / --payment-method-id / --order-id 进
 *     body，--idempotency-key 进 header 逐字透传；金额/币种绝不进 body（服务端以
 *     订单落库权威价 + 令牌固化金额结算，忽略调用方金额）。
 *   - 凭证互斥（R11.5）：恰好其一（仅 token / 仅 method）通过；两缺、两给 → 本地
 *     PARAM_INVALID 且两分支消息可区分、不调用 ApiClient.post（不打平台）。
 *
 * 与 hotel-create-pay.test.ts 同构，采用 helpers.mockApiClient 精确路径匹配。
 *
 * **Validates: Requirements 11.1, 11.2, 11.5**
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

// @inquirer/prompts 被 mock，使非 `--yes` 的 confirm 分支无需 TTY 亦可驱动；本文件
// 以 `--yes` 跳过 confirm，PromptEngine.resolveInput 在传入 --api-key 时直接返回该值，
// 因此 password/input 不会被触达。
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));
import { confirm } from '@inquirer/prompts';

import { registerRideCreateOrderCommand } from '../src/ride-elife/create-order.js';
import { registerRidePayOrderCommand } from '../src/ride-elife/pay-order.js';
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
// Response fixtures（十进制金额，非分；order_ref 为权威 rio_… 订单号）
// ============================================================

/** create-order 锁单成功：AWAITING_PAYMENT / PENDING，携 order_ref 别名。 */
const CREATE_ORDER_RESP = {
  order_ref: 'rio_1',
  order_id: 'rio_1',
  status: 'AWAITING_PAYMENT',
  payment_status: 'PENDING',
  is_scheduled: false,
  order_type: 'realtime',
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_1' },
};

/** 仅返回 order_id（无 order_ref 别名）—— 验证渲染器回退解析权威订单号。 */
const CREATE_ORDER_RESP_ID_ONLY = {
  order_id: 'rio_2',
  status: 'AWAITING_PAYMENT',
  payment_status: 'PENDING',
  price: { amount: 88, currency: 'EUR', quote_id: 'qte_2' },
};

/** pay 结算成功：AWAITING_PAYMENT → PAID / SETTLED，令牌直扣通道 upi_agent。 */
const PAY_ORDER_RESP = {
  order_ref: 'rio_1',
  order_id: 'rio_1',
  ride_id: 'ride_1',
  status: 'PAID',
  payment_status: 'SETTLED',
  payment_channel: 'upi_agent',
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_1' },
};

// ============================================================
// Program builder
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function rideProgram(apiClient: Mock) {
  const program = buildProgram();
  const ride = program.command('ride-elife');
  const deps = { apiClient: apiClient as unknown as ApiClient };
  registerRideCreateOrderCommand(ride, deps);
  registerRidePayOrderCommand(ride, deps);
  return program;
}

const BASE = ['node', 'cli', 'ride-elife'];

// ============================================================
// create-order（R11.1）
// ============================================================

describe('ride-elife create-order', () => {
  const createOrderArgs = (extra: string[] = []) => [
    ...BASE, 'create-order', '--api-key', 'k',
    '--quote-id', 'qte_1', '--vehicle-class', 'Sedan',
    '--price-amount', '42.50', '--price-currency', 'USD',
    '--passenger-name', 'Alice', '--passenger-phone', '+14155551234',
    '--passenger-email', 'alice@example.com',
    ...extra,
  ];

  it('TC-CREATE-ORDER-01: --yes 成功路径 POST /ride/create-order；order_ref+权威金额/币种回显；Idempotency-Key 走 header；body 不含支付凭证', async () => {
    const api = mockApiClient({ '/ride/create-order': CREATE_ORDER_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(createOrderArgs(['--yes', '--idempotency-key', 'co-1', '--format', 'json']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/ride/create-order');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });

    // 行程/报价/乘客上下文入 body；金额 number 化（十进制，非分），默认币种保留。
    expect(body.quote_id).toBe('qte_1');
    expect(body.vehicle_class).toBe('Sedan');
    expect(body.price_amount).toBe(42.5);
    expect(typeof body.price_amount).toBe('number');
    expect(body.price_currency).toBe('USD');
    expect(body.passenger_name).toBe('Alice');
    expect(body.passenger_phone).toBe('+14155551234');
    expect(body.passenger_email).toBe('alice@example.com');

    // Idempotency-Key 走 header，绝不进 body。
    expect(headers).toEqual({ 'Idempotency-Key': 'co-1' });
    expect(body).not.toHaveProperty('idempotency_key');
    expect(body).not.toHaveProperty('Idempotency-Key');

    // 锁单不碰钱 —— body 不携带任何支付凭证。
    expect(body).not.toHaveProperty('payment_token_id');
    expect(body).not.toHaveProperty('payment_method_id');
    expect(body).not.toHaveProperty('authorized_merchant_trans_id');
    expect(body).not.toHaveProperty('payment_order_id');

    // 输出回显权威 order_ref + 金额 + 币种 + 锁单态。
    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_ref).toBe('rio_1');
    expect(payload.status).toBe('AWAITING_PAYMENT');
    expect(payload.payment_status).toBe('PENDING');
    expect(payload.price.amount).toBe(42.5);
    expect(payload.price.currency).toBe('USD');
    expect(payload.price.quote_id).toBe('qte_1');
    // confirm 在 --yes 下被跳过。
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('TC-CREATE-ORDER-02: table 输出含权威 order_ref 与金额/币种（order_ref 缺失时回退 order_id）', async () => {
    const api = mockApiClient({ '/ride/create-order': CREATE_ORDER_RESP_ID_ONLY });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(createOrderArgs(['--yes', '--idempotency-key', 'co-2', '--format', 'table']));

    const text = out.text();
    // 渲染器在无 order_ref 时回退到 order_id 解析权威订单号。
    expect(text).toContain('rio_2');
    // 权威金额 + 币种逐字呈现（十进制，非分）。
    expect(text).toContain('88 EUR');
  });

  it('TC-CREATE-ORDER-03: --yes 下缺 --idempotency-key → PARAM_IDEMPOTENCY_KEY_REQUIRED，不发请求', async () => {
    const api = mockApiClient({ '/ride/create-order': CREATE_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(createOrderArgs(['--yes'])),
    ).rejects.toMatchObject({ code: 'PARAM_IDEMPOTENCY_KEY_REQUIRED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-CREATE-ORDER-04: 缺必填 --quote-id → PARAM_INVALID，不发请求', async () => {
    const api = mockApiClient({ '/ride/create-order': CREATE_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'create-order', '--api-key', 'k',
        '--vehicle-class', 'Sedan', '--price-amount', '42.50',
        '--passenger-name', 'Alice', '--passenger-phone', '+14155551234',
        '--passenger-email', 'alice@example.com',
        '--yes', '--idempotency-key', 'co-3',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// pay-order（R11.2、R11.4）
// ============================================================

describe('ride-elife pay-order', () => {
  const payArgs = (extra: string[] = []) => [
    ...BASE, 'pay-order', '--api-key', 'k', '--order-id', 'rio_1',
    ...extra,
  ];

  it('TC-PAY-ORDER-01: --payment-token-id 主路径 POST /ride/pay；order_id+payment_token_id 进 body；金额/币种不进 body；Idempotency-Key 走 header；回显 PAID/SETTLED', async () => {
    const api = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(payArgs(['--payment-token-id', 'ptk_1', '--yes', '--idempotency-key', 'pay-1', '--format', 'json']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/ride/pay');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });

    // order_ref + 令牌逐字进 body。
    expect(body.order_id).toBe('rio_1');
    expect(body.payment_token_id).toBe('ptk_1');
    // 单一凭证 → 不带 method 分支。
    expect(body).not.toHaveProperty('payment_method_id');

    // 金额/币种绝不进 body（服务端以订单权威价 + 令牌固化金额结算，R2.6）。
    expect(body).not.toHaveProperty('price_amount');
    expect(body).not.toHaveProperty('price_currency');
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('currency');

    // Idempotency-Key 走 header，绝不进 body。
    expect(headers).toEqual({ 'Idempotency-Key': 'pay-1' });
    expect(body).not.toHaveProperty('idempotency_key');
    expect(body).not.toHaveProperty('Idempotency-Key');

    // 成功结算回显 PAID / SETTLED + 权威 order_ref。
    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_ref).toBe('rio_1');
    expect(payload.status).toBe('PAID');
    expect(payload.payment_status).toBe('SETTLED');
    expect(payload.payment_channel).toBe('upi_agent');
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('TC-PAY-ORDER-02: 仅 --payment-method-id（EVO 兜底）逐字进 body，不带 payment_token_id', async () => {
    const api = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(payArgs(['--payment-method-id', 'pm_1', '--yes', '--idempotency-key', 'pay-2', '--format', 'json']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, , body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/ride/pay');
    expect(body.order_id).toBe('rio_1');
    expect(body.payment_method_id).toBe('pm_1');
    expect(body).not.toHaveProperty('payment_token_id');
    // 金额/币种同样不进 body。
    expect(body).not.toHaveProperty('price_amount');
    expect(body).not.toHaveProperty('amount');
  });

  it('TC-PAY-ORDER-03: --authorized-merchant-trans-id（3DS 续单）随 EVO 兜底逐字进 body', async () => {
    const api = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(payArgs([
      '--payment-method-id', 'pm_1',
      '--authorized-merchant-trans-id', 'mt_evo_1',
      '--yes', '--idempotency-key', 'pay-3', '--format', 'json',
    ]));

    const body = api.post.mock.calls[0][2] as Record<string, any>;
    expect(body.order_id).toBe('rio_1');
    expect(body.payment_method_id).toBe('pm_1');
    expect(body.authorized_merchant_trans_id).toBe('mt_evo_1');
  });

  it('TC-PAY-ORDER-04: 缺 --order-id → PARAM_INVALID，不发请求', async () => {
    const api = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'pay-order', '--api-key', 'k',
        '--payment-token-id', 'ptk_1', '--yes', '--idempotency-key', 'pay-4',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // 凭证互斥（R11.5）：非恰好其一 → 本地拒绝、不打平台
  // ----------------------------------------------------------

  it('TC-PAY-ORDER-05: 两个凭证皆缺 → PARAM_INVALID（Neither）、不调用 ApiClient.post', async () => {
    const api = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(payArgs(['--yes', '--idempotency-key', 'pay-5'])),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-PAY-ORDER-06: 两个凭证同给 → PARAM_INVALID（mutually exclusive）、不调用 ApiClient.post', async () => {
    const api = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(payArgs([
        '--payment-token-id', 'ptk_1', '--payment-method-id', 'pm_1',
        '--yes', '--idempotency-key', 'pay-6',
      ])),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-PAY-ORDER-07: 两缺 与 两给 的错误消息可区分（Neither vs. mutually exclusive）', async () => {
    // 两缺分支
    const apiNeither = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const progNeither = rideProgram(apiNeither);
    captureStdout();
    captureStderr();
    let neitherErr: any;
    try {
      await progNeither.parseAsync(payArgs(['--yes', '--idempotency-key', 'pay-7a']));
    } catch (e) {
      neitherErr = e;
    }

    // 两给分支
    const apiBoth = mockApiClient({ '/ride/pay': PAY_ORDER_RESP });
    const progBoth = rideProgram(apiBoth);
    let bothErr: any;
    try {
      await progBoth.parseAsync(payArgs([
        '--payment-token-id', 'ptk_1', '--payment-method-id', 'pm_1',
        '--yes', '--idempotency-key', 'pay-7b',
      ]));
    } catch (e) {
      bothErr = e;
    }

    // 两分支都是 PARAM_INVALID，但消息可区分、且都不打平台。
    expect(neitherErr?.code).toBe('PARAM_INVALID');
    expect(bothErr?.code).toBe('PARAM_INVALID');
    expect(String(neitherErr?.message)).toContain('Neither was given');
    expect(String(bothErr?.message)).toContain('mutually exclusive');
    expect(String(neitherErr?.message)).not.toBe(String(bothErr?.message));
    expect(apiNeither.post).not.toHaveBeenCalled();
    expect(apiBoth.post).not.toHaveBeenCalled();
  });
});

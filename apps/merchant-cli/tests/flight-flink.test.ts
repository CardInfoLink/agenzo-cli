/**
 * Command-level integration tests for flight-flink verbs.
 * Mocks ApiClient (no real backend). Verbs are registered on a flight-flink
 * sub-command group, matching the production wiring in index.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn(), password: vi.fn(), select: vi.fn() }));

import { confirm } from '@inquirer/prompts';

import { registerFindAirportCommand } from '../src/flight-flink/find-airport.js';
import { registerSearchCommand } from '../src/flight-flink/search.js';
import { registerVerifyCommand } from '../src/flight-flink/verify.js';
import { registerCreateOrderCommand } from '../src/flight-flink/create-order.js';
import { registerPayOrderCommand } from '../src/flight-flink/pay-order.js';
import { registerGetOrderCommand } from '../src/flight-flink/get-order.js';
import { registerCancelOrderCommand } from '../src/flight-flink/cancel-order.js';
import { registerListOrdersCommand } from '../src/flight-flink/list-orders.js';
import { registerMoreOffersCommand } from '../src/flight-flink/more-offers.js';
import { registerChangePayCommand } from '../src/flight-flink/change-pay.js';
import { registerRefundApplyCommand } from '../src/flight-flink/refund-apply.js';
import { registerRefundConfirmCommand } from '../src/flight-flink/refund-confirm.js';
import { buildProgram, captureStdout, parseJsonOutput } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); delete process.env.AGENZO_FORMAT; });

// ── Mock API (substring match on path) ────────────────────────────────────
function flightApi(responses: Record<string, unknown>) {
  const handler = vi.fn().mockImplementation((path: string) => {
    for (const [key, data] of Object.entries(responses)) {
      if (path.includes(key)) return Promise.resolve({ success: true, data });
    }
    return Promise.resolve({ success: true, data: {} });
  });
  return { get: handler, post: handler } as unknown as ApiClient;
}
type Deps = { apiClient: ApiClient };

// ── Fixtures ──────────────────────────────────────────────────────────────
const FIND = { cities: [{ city_code: 'BJS', airports: [{ code: 'PEK' }] }] };
const SEARCH = { offers: [{ product_token: 'pt_1', price_key_ready: true, price_total: 1200 }] };
const VERIFY = { product_token: 'pt_v1', price_changed: false };
const CREATE = { order_no: 'ffo_1', order_status: 2 };
const PAY = { order_no: 'ffo_1', pay_status: 1 };
const GET = { order_no: 'ffo_1', status: 'TICKETED', ticket_infos: [{ ticket_no: 'T1' }] };
const CANCEL = { order_no: 'ffo_1', status: 'CANCELLED' };
const LIST = { orders: [{ order_no: 'ffo_1' }], total: 1 };
const MORE = { offers: [{ price_total: 1100 }] };
const REFUND_A = { refund_order_no: 'rfn_1' };
const REFUND_C = { refund_order_no: 'rfn_1', status: 5 };
const CHANGE_PAY = { change_order_no: 'C1', status: 'PROCESSING', payment_status: 'SETTLED' };

// ── Helper: flight-flink subcommand group (mirrors index.ts) ──────────────
function setup(register: (parent: any, deps: Deps) => void, responses: Record<string, unknown>) {
  const deps: Deps = { apiClient: flightApi(responses) };
  const prog = buildProgram();
  const flightCmd = prog.command('flight-flink');
  register(flightCmd, deps);
  return prog;
}

/**
 * Same wiring as `setup`, but also hands back the mocked post handler so a test
 * can assert on the request body (setup() only returns the program).
 */
function setupWithPost(register: (parent: any, deps: Deps) => void, responses: Record<string, unknown>) {
  const api = flightApi(responses);
  const prog = buildProgram();
  const flightCmd = prog.command('flight-flink');
  register(flightCmd, { apiClient: api });
  return { prog, post: api.post as unknown as Mock };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('flight-flink: find-airport', () => {
  it('json output contains city candidates', async () => {
    const prog = setup(registerFindAirportCommand, { '/flight/find-airport': FIND });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'find-airport', '--api-key', 'k', '--keyword', 'bj', '--format', 'json']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.cities[0].city_code).toBe('BJS');
  });
});

describe('flight-flink: search', () => {
  it('json output contains offers', async () => {
    const prog = setup(registerSearchCommand, { '/flight/search': SEARCH });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'search', '--api-key', 'k', '--format', 'json',
      '--trip-type', '1', '--journeys', '[{"date":"2026-08-01","origin":"PEK","originType":"2","destination":"SHA","destinationType":"2"}]']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.offers[0].product_token).toBe('pt_1');
  });
});

describe('flight-flink: verify', () => {
  it('returns authoritative product_token', async () => {
    const prog = setup(registerVerifyCommand, { '/flight/verify': VERIFY });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'verify', '--api-key', 'k', '--format', 'json', '--product-token', 'pt_1']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.product_token).toBe('pt_v1');
  });
});

describe('flight-flink: create-order', () => {
  it('returns order_no', async () => {
    const prog = setup(registerCreateOrderCommand, { '/flight/create-order': CREATE });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'create-order', '--api-key', 'k', '--format', 'json', '--yes',
      '--product-token', 'pt_v1', '--total-amount', '1200', '--currency', 'CNY',
      '--contact-name', 'Z', '--contact-region', '86', '--contact-phone', '138', '--contact-email', 'a@b.com',
      '--passengers', '[{"firstName":"S","lastName":"Z","gender":"1","birthday":"1990-01-01","id_type":"1","id_number":"E1","nationality":"CN","type":"adult","expiration":"2032-01-01"}]',
      '--idempotency-key', 'k1']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.order_no).toBe('ffo_1');
  });
});

describe('flight-flink: pay-order', () => {
  it('returns pay_status', async () => {
    const prog = setup(registerPayOrderCommand, { '/pay': PAY });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'pay-order', '--api-key', 'k', '--format', 'json', '--yes',
      '--order-no', 'ffo_1', '--idempotency-key', 'k2']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.pay_status).toBe(1);
  });
});

describe('flight-flink: get-order', () => {
  it('returns TICKETED with ticket_infos', async () => {
    const prog = setup(registerGetOrderCommand, { '/status': GET });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'get-order', '--api-key', 'k', '--format', 'json', '--order-no', 'ffo_1']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.status).toBe('TICKETED');
    expect(p.ticket_infos).toHaveLength(1);
  });
});

describe('flight-flink: cancel-order', () => {
  it('returns CANCELLED', async () => {
    const prog = setup(registerCancelOrderCommand, { '/cancel': CANCEL });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'cancel-order', '--api-key', 'k', '--format', 'json', '--yes',
      '--order-no', 'ffo_1', '--idempotency-key', 'k3']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.status).toBe('CANCELLED');
  });
});

describe('flight-flink: list-orders', () => {
  it('returns paginated list', async () => {
    const prog = setup(registerListOrdersCommand, { '/flight/orders': LIST });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'list-orders', '--api-key', 'k', '--format', 'json']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.orders).toHaveLength(1);
  });
});

describe('flight-flink: more-offers', () => {
  it('returns additional offers', async () => {
    const prog = setup(registerMoreOffersCommand, { '/flight/more-offers': MORE });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'more-offers', '--api-key', 'k', '--format', 'json', '--product-token', 'pt_1']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.offers[0].price_total).toBe(1100);
  });
});

describe('flight-flink: change-pay', () => {
  const args = (extra: string[]) => [
    'node', 'test', 'flight-flink', 'change-pay', '--api-key', 'k', '--format', 'json',
    '--change-order-no', 'C1', '--order-no', 'ffo_1', '--amount', '120', '--currency', 'USD',
    ...extra,
  ];

  it('returns payment_status', async () => {
    const prog = setup(registerChangePayCommand, { '/flight/change/': CHANGE_PAY });
    const out = captureStdout();
    await prog.parseAsync(args(['--yes', '--idempotency-key', 'k6']));
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.payment_status).toBe('SETTLED');
  });

  it('--authorized-merchant-trans-id is forwarded as authorized_merchant_trans_id（3DS 挑战续单）', async () => {
    // 改签费现结已从「预授权+捕获」改为绑卡直扣一次成交；直扣遇 EVO 要求 3DS 时返回挑战，
    // 前端带用户认证完成后用这个参数重入 change-pay，平台只核验那笔已成交并补做出票。
    const { prog, post } = setupWithPost(registerChangePayCommand, { '/flight/change/': CHANGE_PAY });
    const out = captureStdout();
    await prog.parseAsync(args(['--yes', '--idempotency-key', 'k6-3ds', '--authorized-merchant-trans-id', 'mt_evo_1']));
    out.spy.mockRestore();

    const [path, auth, body] = post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/flight/change/C1/pay');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.authorized_merchant_trans_id).toBe('mt_evo_1');
    // 续单不额外指定支付凭证时，仍不带这两个字段（平台据 trans id 找那笔已成交的直扣）。
    expect(body).not.toHaveProperty('payment_method_id');
    expect(body).not.toHaveProperty('payment_token_id');
  });

  it('不传时不带该字段，保持向后兼容', async () => {
    const { prog, post } = setupWithPost(registerChangePayCommand, { '/flight/change/': CHANGE_PAY });
    const out = captureStdout();
    await prog.parseAsync(args(['--yes', '--idempotency-key', 'k6-plain']));
    out.spy.mockRestore();

    const body = post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('authorized_merchant_trans_id');
    expect(body.order_no).toBe('ffo_1');
    expect(body.amount).toBe(120);
    expect(body.currency).toBe('USD');
  });

  it('续单确认语不再说「charges the customer」（钱已经扣过了）', async () => {
    const confirmMock = vi.mocked(confirm);
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    const { prog } = setupWithPost(registerChangePayCommand, { '/flight/change/': CHANGE_PAY });
    const out = captureStdout();
    // 无 --yes → 走确认分支；--idempotency-key 显式给出，避免走交互输入。
    await prog.parseAsync(args(['--idempotency-key', 'k6-confirm', '--authorized-merchant-trans-id', 'mt_evo_1']));
    out.spy.mockRestore();

    const message = String((confirmMock.mock.calls[0][0] as { message: string }).message);
    expect(message).toContain('already settled');
    expect(message).not.toContain('charges the customer');
  });

  it('非续单确认语仍明说会扣款', async () => {
    const confirmMock = vi.mocked(confirm);
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    const { prog } = setupWithPost(registerChangePayCommand, { '/flight/change/': CHANGE_PAY });
    const out = captureStdout();
    await prog.parseAsync(args(['--idempotency-key', 'k6-confirm2']));
    out.spy.mockRestore();

    const message = String((confirmMock.mock.calls[0][0] as { message: string }).message);
    expect(message).toContain('charges the customer');
  });
});

describe('flight-flink: refund-apply', () => {
  it('returns refund_order_no', async () => {
    const prog = setup(registerRefundApplyCommand, { '/flight/refund/apply': REFUND_A });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'refund-apply', '--api-key', 'k', '--format', 'json', '--yes',
      '--order-no', 'ffo_1', '--passenger', 'P1', '--segment-id', 'S1', '--reason-type', '1',
      '--contact-name', 'X', '--contact-region', '86', '--contact-phone', '138', '--contact-email', 'a@b.com',
      '--idempotency-key', 'k4']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.refund_order_no).toBe('rfn_1');
  });
});

describe('flight-flink: refund-confirm', () => {
  it('returns terminal status', async () => {
    const prog = setup(registerRefundConfirmCommand, { '/confirm': REFUND_C });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'flight-flink', 'refund-confirm', '--api-key', 'k', '--format', 'json', '--yes',
      '--refund-order-no', 'rfn_1', '--confirm', '1', '--idempotency-key', 'k5']);
    out.spy.mockRestore();
    const p = parseJsonOutput(out.text()) as any;
    expect(p.refund_order_no).toBe('rfn_1');
  });
});

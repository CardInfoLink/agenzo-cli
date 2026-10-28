import { registerPayCommand } from '../src/payments/capture.js';
import {
  buildProgram,
  captureStdout,
  captureStderr,
  mockApiClient,
} from '../../token-cli/tests/helpers.js';

/**
 * `payments capture` 的价格批注（原价 / 优惠金额）flag。
 *
 * 平台侧语义是「纯记录」：落我们自己的 MongoDB 并回显，不进收单网关报文、不参与扣款金额。
 * CLI 这一层要守住的是：**只在 flag 真的出现时写进 body**（0 不被折叠成「没给」），
 * 格式错误在本地就挡住，以及服务端回显的值能被渲染出来。
 */

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const CHARGE_RESULT = {
  charge_no: 'chg_abc123',
  payment_brand: 'evo',
  amount_cents: 8000,
  fee_cents: 0,
  total_cents: 8000,
  currency: 'USD',
  pay_status: 'success',
  merchant_trans_id: 'M001',
  evo_trans_id: 'E001',
  original_amount_cents: 10000,
  discount_amount_cents: 2000,
};

function run(extraArgs: string[], result: Record<string, unknown> = CHARGE_RESULT) {
  const apiClient = mockApiClient({ '/pay': result });
  const program = buildProgram();
  registerPayCommand(program, { apiClient } as any);
  const out = captureStdout();
  captureStderr();
  return {
    apiClient,
    out,
    parse: () =>
      program.parseAsync([
        'node',
        'cli',
        'capture',
        '--api-key',
        'sk_key',
        '--payment-token-id',
        'ptk_abc',
        '--idempotency-key',
        'idem_1',
        '--yes',
        ...extraArgs,
      ]),
  };
}

describe('capture — price annotation', () => {
  it('forwards both fields as integers in the request body', async () => {
    const { apiClient, parse } = run([
      '--original-amount-cents',
      '10000',
      '--discount-amount-cents',
      '2000',
    ]);

    await parse();

    const body = apiClient.post.mock.calls[0][2];
    expect(body.original_amount_cents).toBe(10000);
    expect(body.discount_amount_cents).toBe(2000);
    // 金额仍不由调用方传：批注不是 amount。
    expect(body.amount_cents).toBeUndefined();
  });

  it('omits both keys entirely when the flags are absent', async () => {
    const { apiClient, parse } = run([]);

    await parse();

    const body = apiClient.post.mock.calls[0][2];
    expect('original_amount_cents' in body).toBe(false);
    expect('discount_amount_cents' in body).toBe(false);
  });

  it('forwards a declared zero discount (0 means "no discount", not "not given")', async () => {
    const { apiClient, parse } = run(['--discount-amount-cents', '0']);

    await parse();

    const body = apiClient.post.mock.calls[0][2];
    expect(body.discount_amount_cents).toBe(0);
    expect('original_amount_cents' in body).toBe(false);
  });

  it('forwards only the declared side when just one flag is given', async () => {
    const { apiClient, parse } = run(['--original-amount-cents', '9900']);

    await parse();

    const body = apiClient.post.mock.calls[0][2];
    expect(body.original_amount_cents).toBe(9900);
    expect('discount_amount_cents' in body).toBe(false);
  });

  it.each([
    ['--original-amount-cents', '-1'],
    ['--original-amount-cents', '12.5'],
    ['--original-amount-cents', 'abc'],
    ['--discount-amount-cents', '-100'],
  ])('rejects %s %s locally as PARAM_INVALID', async (flag, value) => {
    const { apiClient, parse } = run([flag, value]);

    await expect(parse()).rejects.toThrow(/PARAM_INVALID|Invalid/);
    // 本地挡下，绝不发请求。
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('renders the echoed annotation in text output', async () => {
    const { out, parse } = run(['--original-amount-cents', '10000', '--discount-amount-cents', '2000']);

    await parse();

    const text = out.text();
    expect(text).toContain('Original');
    expect(text).toContain('100.00');
    expect(text).toContain('Discount');
    expect(text).toContain('20.00');
  });

  it('does not render annotation rows when the server echoes null', async () => {
    const { out, parse } = run([], {
      ...CHARGE_RESULT,
      original_amount_cents: null,
      discount_amount_cents: null,
    });

    await parse();

    const text = out.text();
    expect(text).not.toContain('Original');
    expect(text).not.toContain('Discount');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerVisaDrawCommand } from '../src/payment-tokens/visa-draw.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('x'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const DRAW_PATH = '/payment-tokens/ptk_auth_1/visa/draw';

/** 平台返回的子令牌：ACTIVE，parent 指向授权令牌。 */
const CHILD_ACTIVE = {
  id: 'ptk_child_1',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'visa',
  network_token: {
    brand: 'Visa',
    value: '4323126883611456',
    cryptogram: 'AgAAAAAAPX7dmwEAmfSdgwQAAAg=',
    expiry_date: '0128',
  },
};

const BASE = [
  'node', 'cli', '--yes', 'payment-tokens', 'visa-draw', 'ptk_auth_1',
  '--api-key', 'sk_key',
  '--order-amount-cents', '2500',
  '--idempotency-key', 'idem_draw_1',
];

function setup(responses: Record<string, unknown> = { [DRAW_PATH]: CHILD_ACTIVE }) {
  const apiClient = mockApiClient(responses);
  const program = buildProgram();
  registerVisaDrawCommand(program.command('payment-tokens'), { apiClient } as any);
  const out = captureStdout();
  captureStderr();
  return { apiClient, program, out };
}

describe('payment-tokens visa-draw — request', () => {
  it('POSTs a flat body to /payment-tokens/{id}/visa/draw with the Idempotency-Key header', async () => {
    const { apiClient, program } = setup();
    await program.parseAsync(BASE);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = apiClient.post.mock.calls[0];
    expect(path).toBe(DRAW_PATH);
    expect(auth).toEqual({ type: 'api-key', key: 'sk_key' });
    expect(body).toEqual({ order_amount_cents: 2500 });
    expect(headers).toEqual({ 'Idempotency-Key': 'idem_draw_1' });
  });

  it('forwards the optional fields as-is', async () => {
    const { apiClient, program } = setup();
    const order = { description: 'Extra seats', products: [{ product_name: 'Seat', quantity: 5, unit_price_cents: 500 }] };
    await program.parseAsync([
      ...BASE,
      '--currency', 'USD',
      '--external-transaction-id', 'ORDER_7',
      '--order', JSON.stringify(order),
      '--member', 'mem_1',
    ]);
    expect(apiClient.post.mock.calls[0][2]).toEqual({
      order_amount_cents: 2500,
      currency: 'USD',
      external_transaction_id: 'ORDER_7',
      order,
      member_id: 'mem_1',
    });
  });

  it('--last sends is_last: true; omitting it leaves the body unchanged', async () => {
    const { apiClient, program } = setup();
    await program.parseAsync([...BASE, '--last']);
    expect(apiClient.post.mock.calls[0][2]).toEqual({ order_amount_cents: 2500, is_last: true });

    const again = setup();
    await again.program.parseAsync(BASE);
    expect(again.apiClient.post.mock.calls[0][2]).not.toHaveProperty('is_last');
  });

  it('marks the last draw in text output', async () => {
    const { program, out } = setup();
    await program.parseAsync([...BASE, '--last']);
    expect(out.text()).toContain('Last Draw');
  });

  it('exposes no limit / expiry / subscription / card flags — the authorization owns those', async () => {
    const help = (() => {
      const program = buildProgram();
      registerVisaDrawCommand(program.command('payment-tokens'), { apiClient: mockApiClient() } as any);
      return program.commands[0].commands[0].helpInformation();
    })();
    for (const flag of ['--max-amount-cents', '--expires-at', '--recurring', '--subscription', '--payment-method-id']) {
      expect(help).not.toContain(flag);
    }
  });
});

describe('payment-tokens visa-draw — local validation (no request sent)', () => {
  it.each([['12.5'], ['0'], ['abc'], ['100000000']])('rejects --order-amount-cents %s', async (bad) => {
    const { apiClient, program } = setup();
    const argv = [...BASE];
    argv[argv.indexOf('2500')] = bad;
    await expect(program.parseAsync(argv)).rejects.toThrow(/order-amount-cents/);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('requires --order-amount-cents in --yes mode', async () => {
    const { apiClient, program } = setup();
    await expect(
      program.parseAsync(['node', 'cli', '--yes', 'payment-tokens', 'visa-draw', 'ptk_auth_1', '--api-key', 'k', '--idempotency-key', 'i']),
    ).rejects.toThrow(/order-amount-cents/);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const { apiClient, program } = setup();
    await expect(
      program.parseAsync(['node', 'cli', '--yes', 'payment-tokens', 'visa-draw', 'ptk_auth_1', '--api-key', 'k', '--order-amount-cents', '100']),
    ).rejects.toThrow(/idempotency/i);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('rejects --order that is not a JSON object', async () => {
    const { apiClient, program } = setup();
    await expect(program.parseAsync([...BASE, '--order', '[1]'])).rejects.toThrow(/--order must be a JSON object/);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('does not require --member (CLI is a pass-through)', async () => {
    const { apiClient, program } = setup();
    await program.parseAsync(BASE);
    expect(apiClient.post.mock.calls[0][2]).not.toHaveProperty('member_id');
  });
});

describe('payment-tokens visa-draw — response handling', () => {
  it('renders the ACTIVE child token with its parent id in text mode', async () => {
    const { program, out } = setup();
    await program.parseAsync(BASE);
    const text = out.text();
    expect(text).toContain('ptk_child_1');
    expect(text).toContain('ptk_auth_1');
    expect(text).toContain('4323126883611456');
  });

  it('emits the full child token under --format json', async () => {
    const { program, out } = setup();
    await program.parseAsync([...BASE.slice(0, 2), '--format', 'json', ...BASE.slice(2)]);
    // 输出是缩进多行 JSON，按全文断言。
    const text = out.text();
    expect(text).toContain('"id": "ptk_child_1"');
    expect(text).toContain('4323126883611456');
  });

  it('platform rejection → throws (non-zero exit), nothing rendered', async () => {
    const apiClient = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        success: false,
        error: { code: 1403, message: 'limit exceeded', data: { reason: 'authorization_limit_exceeded' } },
        status: 400,
      }),
    };
    const program = buildProgram();
    registerVisaDrawCommand(program.command('payment-tokens'), { apiClient } as any);
    captureStdout();
    captureStderr();
    await expect(program.parseAsync(BASE)).rejects.toThrow();
  });

  it('non-ACTIVE status → throws instead of presenting a credential', async () => {
    const { program } = setup({ [DRAW_PATH]: { ...CHILD_ACTIVE, status: 'PENDING' } });
    await expect(program.parseAsync(BASE)).rejects.toThrow(/did not return an ACTIVE token/);
  });
});

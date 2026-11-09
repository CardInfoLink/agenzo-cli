import { describe, it, expect, vi, afterEach } from 'vitest';
import { confirm } from '@inquirer/prompts';
import { registerCreateCommand } from '../src/payment-tokens/create.js';
import { registerVcnQuoteCommand } from '../src/payment-tokens/vcn-quote.js';
import { buildProgram, captureStdout, captureStderr } from './helpers.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('pm_auto'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
  vi.mocked(confirm).mockResolvedValue(true);
});

const VCN_RESPONSE = {
  id: 'ptk_vcn_1',
  type: 'vcn',
  vcn: { card_number: '5249840561741777', cvc: '123', amount_limit: 1000, currency: 'USD', status: 'ACTIVE' },
};

function apiClientFor(quote?: unknown) {
  return {
    get: vi.fn().mockImplementation((path: string) => {
      if (path === '/features/vcn') return Promise.resolve({ success: true, data: { enabled: true } });
      if (path.startsWith('/payment-tokens/vcn-quote')) return Promise.resolve({ success: true, data: quote });
      return Promise.resolve({ success: true, data: {} });
    }),
    post: vi.fn().mockResolvedValue({ success: true, data: VCN_RESPONSE }),
  };
}

async function runCreate(apiClient: ReturnType<typeof apiClientFor>, extra: string[], yes = true) {
  const program = buildProgram();
  registerCreateCommand(program.command('payment-tokens'), { apiClient } as any);
  const out = captureStdout();
  const err = captureStderr();
  await program.parseAsync([
    'node', 'cli', ...(yes ? ['--yes'] : []), 'payment-tokens', 'create',
    '--api-key', 'sk_key', '--type', 'vcn', '--payment-method-id', 'pm_1',
    '--amount', '10.00', '--idempotency-key', 'chg_fund_1', ...extra,
  ]);
  return { out, err };
}

describe('payment-tokens create --type vcn --funding-charge-no', () => {
  it('forwards funding_charge_no in the body', async () => {
    const apiClient = apiClientFor();
    await runCreate(apiClient, ['--funding-charge-no', ' chg_fund_1 ']);

    const body = apiClient.post.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'vcn', amount: 1000, funding_charge_no: 'chg_fund_1' });
  });

  it('--amount-cents is sent as integer cents and wins over --amount', async () => {
    const apiClient = apiClientFor();
    await runCreate(apiClient, ['--amount-cents', '1150', '--funding-charge-no', 'chg_fund_1']);

    expect(apiClient.post.mock.calls[0][2]).toMatchObject({ amount: 1150 });
  });

  it('rejects a non-integer --amount-cents before any request', async () => {
    const apiClient = apiClientFor();
    await expect(runCreate(apiClient, ['--amount-cents', '11.5'])).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('--external-transaction-id is sent as external_transaction_id (the field the platform reads)', async () => {
    const apiClient = apiClientFor();
    await runCreate(apiClient, ['--funding-charge-no', 'chg_fund_1', '--external-transaction-id', ' ord_123 ']);

    const body = apiClient.post.mock.calls[0][2] as Record<string, unknown>;
    expect(body.external_transaction_id).toBe('ord_123');
    expect(body).not.toHaveProperty('external_tx_id');
  });

  it('--card-bin is sent as card_bin', async () => {
    const apiClient = apiClientFor();
    await runCreate(apiClient, ['--funding-charge-no', 'chg_fund_1', '--card-bin', ' 558325 ']);

    expect(apiClient.post.mock.calls[0][2]).toMatchObject({ card_bin: '558325' });
  });

  it('omits card_bin when --card-bin is not given', async () => {
    const apiClient = apiClientFor();
    await runCreate(apiClient, ['--funding-charge-no', 'chg_fund_1']);

    expect(apiClient.post.mock.calls[0][2]).not.toHaveProperty('card_bin');
  });

  it.each(['52498', '524984123', '52498a'])('rejects malformed --card-bin %s before any request', async (bin) => {
    const apiClient = apiClientFor();
    await expect(
      runCreate(apiClient, ['--funding-charge-no', 'chg_fund_1', '--card-bin', bin]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('omits funding_charge_no when the flag is not given', async () => {
    const apiClient = apiClientFor();
    await runCreate(apiClient, []);

    expect(apiClient.post.mock.calls[0][2]).not.toHaveProperty('funding_charge_no');
  });

  it('does not show a freeze / 5% fee warning when the card is already funded', async () => {
    const apiClient = apiClientFor();
    const { err } = await runCreate(
      apiClient,
      ['--funding-charge-no', 'chg_fund_1', '--member', 'm_1'],
      false,
    );

    expect(confirm).toHaveBeenCalled();

    expect(err.text()).not.toContain('Freeze');
  });
});

describe('payment-tokens vcn-quote', () => {
  const QUOTE = { amount_cents: 1000, fee_cents: 150, total_cents: 1150, currency: 'USD' };

  async function runQuote(apiClient: ReturnType<typeof apiClientFor>, extra: string[]) {
    const program = buildProgram();
    registerVcnQuoteCommand(program.command('payment-tokens'), { apiClient } as any);
    const out = captureStdout();
    captureStderr();
    await program.parseAsync(['node', 'cli', 'payment-tokens', 'vcn-quote', '--api-key', 'sk_key', ...extra]);
    return out;
  }

  it('--card-bin is sent as card_bin', async () => {
    const apiClient = apiClientFor({ ...QUOTE, card_bin: '524984' });
    await runQuote(apiClient, ['--amount-cents', '1000', '--card-bin', '524984']);

    expect(apiClient.get.mock.calls[0][0]).toBe('/payment-tokens/vcn-quote?amount_cents=1000&card_bin=524984');
  });

  it('rejects a malformed --card-bin before any request', async () => {
    const apiClient = apiClientFor(QUOTE);
    await expect(runQuote(apiClient, ['--amount-cents', '1000', '--card-bin', '5249'])).rejects.toThrow();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('converts USD to cents and prints limit / fee / charge total', async () => {
    const apiClient = apiClientFor(QUOTE);
    const out = await runQuote(apiClient, ['--amount', '10.00']);

    expect(apiClient.get).toHaveBeenCalledWith('/payment-tokens/vcn-quote?amount_cents=1000', {
      type: 'api-key',
      key: 'sk_key',
    });
    expect(out.text()).toContain('Charge Total');
    expect(out.text()).toContain('11.50');
  });

  it('passes currency through and emits JSON with --format json', async () => {
    const apiClient = apiClientFor(QUOTE);
    const out = await runQuote(apiClient, ['--amount', '10', '--currency', 'USD', '--format', 'json']);

    expect(apiClient.get.mock.calls[0][0]).toBe('/payment-tokens/vcn-quote?amount_cents=1000&currency=USD');
    expect(JSON.parse(out.text())).toMatchObject({ total_cents: 1150 });
  });

  it('accepts --amount-cents and prefers it over --amount', async () => {
    const apiClient = apiClientFor(QUOTE);
    await runQuote(apiClient, ['--amount-cents', '1000', '--amount', '99.00']);

    expect(apiClient.get.mock.calls[0][0]).toBe('/payment-tokens/vcn-quote?amount_cents=1000');
  });

  it.each(['10.5', '-1', 'x'])('rejects invalid --amount-cents %s', async (cents) => {
    const apiClient = apiClientFor(QUOTE);
    await expect(runQuote(apiClient, ['--amount-cents', cents])).rejects.toThrow();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '1.234'])('rejects invalid amount %s without calling the API', async (amount) => {
    const apiClient = apiClientFor(QUOTE);
    await expect(runQuote(apiClient, ['--amount', amount])).rejects.toThrow();
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});

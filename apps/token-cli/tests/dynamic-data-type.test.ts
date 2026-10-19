import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dynamicDataLine,
  parseDynamicDataType,
} from '../src/payment-tokens/dynamic-data-type.js';
import { registerVisaCreateCommand } from '../src/payment-tokens/visa-create.js';
import { registerVisaDrawCommand } from '../src/payment-tokens/visa-draw.js';
import { registerGetCommand } from '../src/payment-tokens/get.js';
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

describe('parseDynamicDataType', () => {
  it('returns undefined when the flag is absent, so the request body stays unchanged', () => {
    expect(parseDynamicDataType(undefined)).toBeUndefined();
  });

  it.each([
    ['TAVV', 'TAVV'],
    ['DAVV', 'DAVV'],
    ['davv', 'DAVV'],
    [' tavv ', 'TAVV'],
  ])('accepts %j as %s', (raw, expected) => {
    expect(parseDynamicDataType(raw)).toBe(expected);
  });

  it.each(['DTVV', 'NONE', '', 'TAVV,DAVV', 'cvv'])('rejects %j', (raw) => {
    expect(() => parseDynamicDataType(raw)).toThrow(/--dynamic-data-type/);
  });
});

describe('dynamicDataLine', () => {
  it('shows the dynamic CVV for DAVV', () => {
    expect(dynamicDataLine({ dynamic_data_type: 'DAVV', cvv: '123', cryptogram: '' })).toEqual([
      'Dynamic CVV (DAVV)',
      '123',
    ]);
  });

  it('shows the cryptogram for TAVV and for older responses without the field', () => {
    expect(dynamicDataLine({ dynamic_data_type: 'TAVV', cryptogram: 'AAAA' })).toEqual([
      'Cryptogram (TAVV)',
      'AAAA',
    ]);
    expect(dynamicDataLine({ cryptogram: 'AAAA' })).toEqual(['Cryptogram (TAVV)', 'AAAA']);
  });
});

const DRAW_PATH = '/payment-tokens/ptk_auth_1/visa/draw';
const DAVV_CHILD = {
  id: 'ptk_child_davv',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'visa',
  network_token: {
    brand: 'Visa',
    value: '4323126883611456',
    cryptogram: '',
    cvv: '482',
    dynamic_data_type: 'DAVV',
    expiry_date: '0128',
  },
};
const DRAW_ARGS = [
  'node', 'cli', '--yes', 'payment-tokens', 'visa-draw', 'ptk_auth_1',
  '--api-key', 'sk_key',
  '--order-amount-cents', '2500',
  '--idempotency-key', 'idem_davv',
];

describe('payment-tokens visa-draw --dynamic-data-type', () => {
  function setup() {
    const apiClient = mockApiClient({ [DRAW_PATH]: DAVV_CHILD });
    const program = buildProgram();
    registerVisaDrawCommand(program.command('payment-tokens'), { apiClient } as any);
    const out = captureStdout();
    captureStderr();
    return { apiClient, program, out };
  }

  it('sends dynamic_data_type: "DAVV" and prints the dynamic CVV', async () => {
    const { apiClient, program, out } = setup();
    await program.parseAsync([...DRAW_ARGS, '--dynamic-data-type', 'davv']);

    expect(apiClient.post.mock.calls[0][2]).toEqual({
      order_amount_cents: 2500,
      dynamic_data_type: 'DAVV',
    });
    expect(out.text()).toContain('Dynamic CVV (DAVV)');
    expect(out.text()).toContain('482');
    expect(out.text()).not.toContain('Cryptogram (TAVV)');
  });

  it('leaves the body unchanged when the flag is absent', async () => {
    const { apiClient, program } = setup();
    await program.parseAsync(DRAW_ARGS);
    expect(apiClient.post.mock.calls[0][2]).toEqual({ order_amount_cents: 2500 });
  });

  it('rejects an unknown type before sending a request', async () => {
    const { apiClient, program } = setup();
    await expect(
      program.parseAsync([...DRAW_ARGS, '--dynamic-data-type', 'DTVV']),
    ).rejects.toThrow(/--dynamic-data-type/);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('payment-tokens visa-create --dynamic-data-type', () => {
  const PENDING = {
    id: 'ptk_visa_001',
    type: 'network_token',
    status: 'PENDING',
    payment_brand: 'visa',
    payment_url: 'https://checkout.visa.example/passkey/abc123',
    payment_url_expires_in: 600,
  };
  const ARGS = [
    'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_visa_1',
    '--order-amount-cents', '12345',
    '--idempotency-key', 'idem_davv_create',
    '--no-poll',
  ];

  function setup() {
    const apiClient = mockApiClient({ '/payment-tokens/create': PENDING });
    const program = buildProgram();
    registerVisaCreateCommand(program.command('payment-tokens'), { apiClient } as any);
    captureStdout();
    captureStderr();
    return { apiClient, program };
  }

  it('puts dynamic_data_type under visa in the create body', async () => {
    const { apiClient, program } = setup();
    await program.parseAsync([...ARGS, '--dynamic-data-type', 'DAVV']);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.visa).toEqual({ order_amount_cents: 12345, dynamic_data_type: 'DAVV' });
  });

  it('adds nothing when the flag is absent — body unchanged for existing callers', async () => {
    const { apiClient, program } = setup();
    await program.parseAsync(ARGS);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.visa).toEqual({ order_amount_cents: 12345 });
  });

  it('rejects an unknown type before sending a request', async () => {
    const { apiClient, program } = setup();
    await expect(
      program.parseAsync([...ARGS, '--dynamic-data-type', 'NONE']),
    ).rejects.toThrow(/--dynamic-data-type/);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('payment-tokens get — Visa DAVV', () => {
  async function run(networkToken: Record<string, unknown>) {
    const apiClient = mockApiClient({
      '/payment-tokens/pt_visa_get': {
        id: 'pt_visa_get',
        type: 'network_token',
        network_token: networkToken,
      },
    });
    const program = buildProgram();
    registerGetCommand(program.command('payment-tokens'), { apiClient } as any);
    const out = captureStdout();
    captureStderr();
    await program.parseAsync(['node', 'cli', 'payment-tokens', 'get', 'pt_visa_get', '--api-key', 'sk_key']);
    return out.text();
  }

  it('shows the dynamic CVV instead of an empty cryptogram', async () => {
    const text = await run({
      brand: 'Visa', value: '4323126883611456', cryptogram: '', cvv: '482',
      dynamic_data_type: 'DAVV', expiry_date: '0128',
    });
    expect(text).toContain('Dynamic CVV (DAVV)');
    expect(text).toContain('482');
    expect(text).not.toMatch(/^Cryptogram/m);
  });

  it('keeps the Cryptogram line for TAVV and for responses without the field', async () => {
    const text = await run({
      brand: 'Visa', value: '4323126883611456', cryptogram: 'AAAA', expiry_date: '0128',
    });
    expect(text).toContain('Cryptogram');
    expect(text).toContain('AAAA');
    expect(text).not.toContain('Dynamic CVV');
  });
});

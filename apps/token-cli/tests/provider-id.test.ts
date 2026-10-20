import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerUnionpayCreateCommand } from '../src/payment-tokens/unionpay-create.js';
import { registerVisaCreateCommand } from '../src/payment-tokens/visa-create.js';
import { registerEvoCreateCommand } from '../src/payment-tokens/evo-create.js';
import { registerVisaDrawCommand } from '../src/payment-tokens/visa-draw.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// 三条铸令牌命令在这里全部跑 --yes（必填参数都给齐），不该触发任何交互提示。
// 防御性地 mock @inquirer/prompts，这样漏判的分支会表现为坏值而不是挂住。
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('pm_auto'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// provider_id 收单门店按供应商路由 —— token-cli 侧的字段透传（AC-1.7 / AC-11.1）
//
// 三条铸令牌命令支持 `--provider-id`，原样转发为平台请求体的 `provider_id`；不传则请求体里
// **不出现**该键（AC-1.7）。三件事在这里被钉住：
//
// 1. **字面量只有两种形态**（AC-11.1）：CLI flag `--provider-id`、请求体 `provider_id`。
//    驼峰 `providerId`（卡片回显形态）与连字符 `provider-id`（base 网关 body field 键形态）
//    属别仓，请求体里一个都不许出现。
// 2. **「省略」与「声明了无效值」是两件事**：判据是 flag 有没有出现，不是真值判断。空串必须
//    原样上送，由平台以 409 PROVIDER_NOT_CONFIGURED fail-closed（AC-2.4）——CLI 把它折叠成
//    「没声明」会让这笔款被悄悄落到默认门店。第三个用例就是这条护栏。
// 3. **`visa-draw` 不接受该 flag**：draw 子令牌的 provider_id 由授权根令牌快照继承。
//
// Validates: AC-1.7, AC-2.4, AC-11.1
// ============================================================

/** 一个已为该 developer 配好映射的承接供应商标识。 */
const PROVIDER_ID = 'redaug';

/** 别仓形态的字段名：请求体里一个都不许出现（AC-11.1）。 */
const FOREIGN_SHAPES = ['providerId', 'provider-id'] as const;

/** PENDING 的 UnionPay 网络令牌响应（unionpay-create 无状态守卫）。 */
const UNIONPAY_PENDING = {
  id: 'ptk_up_001',
  type: 'network_token',
  status: 'PENDING',
  payment_brand: 'unionpay',
  checkout_url: 'https://checkout.unionpay.example/upi/abc123',
  correlation_id: 'corr_1',
};

/** PENDING 的 Visa 网络令牌响应 —— visa-create 要求 PENDING。 */
const VISA_PENDING = {
  id: 'ptk_visa_001',
  type: 'network_token',
  status: 'PENDING',
  payment_brand: 'visa',
  payment_url: 'https://checkout.visa.example/passkey/abc123',
  payment_url_expires_in: 600,
};

/** ACTIVE 终态，让 visa-create 内置轮询在早期一跳就结束。 */
const VISA_ACTIVE = {
  id: 'ptk_visa_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'visa',
  network_token: { brand: 'Visa', value: '4323126883611456', cryptogram: 'x', expiry_date: '0128' },
};

/** ACTIVE 的 EVO 网络令牌响应 —— evo-create 要求 ACTIVE。 */
const EVO_ACTIVE = {
  id: 'ptk_evo_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'evo',
};

/** 用假定时器驱动 visa-create 的轮询等待。 */
async function runWithPoll(action: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    const done = action();
    for (let i = 0; i < 40; i += 1) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    await done;
  } finally {
    vi.useRealTimers();
  }
}

// ------------------------------------------------------------
// unionpay-create
// ------------------------------------------------------------

describe('payment-tokens unionpay-create — --provider-id 透传 (AC-1.7)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', '--yes', 'payment-tokens', 'unionpay-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_up_1',
    '--unionpay-amount', '174.58',
    '--recipient-first-name', 'Ada',
    '--recipient-last-name', 'Lovelace',
    '--recipient-email', 'ada@example.com',
    '--idempotency-key', 'idem_up',
    ...extra,
  ];

  function run(extra: string[]) {
    const apiClient = mockApiClient({ '/payment-tokens/create': UNIONPAY_PENDING });
    const program = buildProgram();
    registerUnionpayCreateCommand(program.command('payment-tokens'), { apiClient } as any);
    captureStdout();
    captureStderr();
    return { apiClient, parse: () => program.parseAsync(baseArgs(extra)) };
  }

  it('给了就作为 provider_id 进请求体（只用 snake_case 这一种形态）', async () => {
    const { apiClient, parse } = run(['--provider-id', PROVIDER_ID]);
    await parse();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.provider_id).toBe(PROVIDER_ID);
    for (const shape of FOREIGN_SHAPES) {
      expect(body).not.toHaveProperty(shape);
    }
  });

  it('没给则整个 provider_id 字段不发', async () => {
    const { apiClient, parse } = run([]);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('provider_id');
  });

  it('空串原样上送（已声明但无效，由平台 409 fail-closed，不等同于没给）', async () => {
    const { apiClient, parse } = run(['--provider-id', '']);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).toHaveProperty('provider_id');
    expect(body.provider_id).toBe('');
  });
});

// ------------------------------------------------------------
// visa-create
// ------------------------------------------------------------

describe('payment-tokens visa-create — --provider-id 透传 (AC-1.7)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', '--yes', 'payment-tokens', 'visa-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_visa_1',
    '--order-amount-cents', '12345',
    '--idempotency-key', 'idem_visa',
    ...extra,
  ];

  function run(extra: string[]) {
    const apiClient = mockApiClient({
      '/payment-tokens/create': VISA_PENDING,
      '/payment-tokens/ptk_visa_001': VISA_ACTIVE,
    });
    const program = buildProgram();
    registerVisaCreateCommand(program.command('payment-tokens'), { apiClient } as any);
    captureStdout();
    captureStderr();
    return { apiClient, parse: () => runWithPoll(() => program.parseAsync(baseArgs(extra))) };
  }

  it('给了就作为 provider_id 进请求体**顶层**（不进嵌套的 visa 子对象）', async () => {
    const { apiClient, parse } = run(['--provider-id', PROVIDER_ID]);
    await parse();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.provider_id).toBe(PROVIDER_ID);
    expect(body.visa).not.toHaveProperty('provider_id');
    for (const shape of FOREIGN_SHAPES) {
      expect(body).not.toHaveProperty(shape);
    }
  });

  it('没给则整个 provider_id 字段不发', async () => {
    const { apiClient, parse } = run([]);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('provider_id');
    expect(body.visa).not.toHaveProperty('provider_id');
  });

  it('空串原样上送（已声明但无效，由平台 409 fail-closed，不等同于没给）', async () => {
    const { apiClient, parse } = run(['--provider-id', '']);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).toHaveProperty('provider_id');
    expect(body.provider_id).toBe('');
  });
});

// ------------------------------------------------------------
// evo-create
// ------------------------------------------------------------

describe('payment-tokens evo-create — --provider-id 透传 (AC-1.7)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_evo_1',
    '--amount-cents', '12345',
    '--idempotency-key', 'idem_evo',
    ...extra,
  ];

  function run(extra: string[]) {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    registerEvoCreateCommand(program.command('payment-tokens'), { apiClient } as any);
    captureStdout();
    captureStderr();
    return { apiClient, parse: () => program.parseAsync(baseArgs(extra)) };
  }

  it('给了就作为 provider_id 进请求体（只用 snake_case 这一种形态）', async () => {
    const { apiClient, parse } = run(['--provider-id', PROVIDER_ID]);
    await parse();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body.provider_id).toBe(PROVIDER_ID);
    for (const shape of FOREIGN_SHAPES) {
      expect(body).not.toHaveProperty(shape);
    }
  });

  it('没给则整个 provider_id 字段不发', async () => {
    const { apiClient, parse } = run([]);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('provider_id');
  });

  it('空串原样上送（已声明但无效，由平台 409 fail-closed，不等同于没给）', async () => {
    const { apiClient, parse } = run(['--provider-id', '']);
    await parse();

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).toHaveProperty('provider_id');
    expect(body.provider_id).toBe('');
  });
});

// ------------------------------------------------------------
// visa-draw —— 否定面：不接受该 flag
// ------------------------------------------------------------
//
// draw 子令牌的 provider_id 由授权根令牌**快照继承**，所以 draw 既不接受该字段、也不参与
// 一致性校验。在这里钉住：help 里没有这个 flag，正常 draw 的请求体也不带该键。

describe('payment-tokens visa-draw — 不接受 --provider-id（父令牌继承）', () => {
  const DRAW_PATH = '/payment-tokens/ptk_auth_1/visa/draw';
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

  it('help 里不含 --provider-id', () => {
    const program = buildProgram();
    registerVisaDrawCommand(program.command('payment-tokens'), { apiClient: mockApiClient() } as any);
    const help = program.commands[0].commands[0].helpInformation();
    expect(help).not.toContain('--provider-id');
  });

  it('一次正常 draw 的请求体不含 provider_id', async () => {
    const apiClient = mockApiClient({ [DRAW_PATH]: CHILD_ACTIVE });
    const program = buildProgram();
    registerVisaDrawCommand(program.command('payment-tokens'), { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'visa-draw', 'ptk_auth_1',
      '--api-key', 'sk_key',
      '--order-amount-cents', '2500',
      '--idempotency-key', 'idem_draw_1',
    ]);

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('provider_id');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerPayCommand } from '../src/payments/capture.js';
import { registerCaptureResumeCommand } from '../src/payments/capture-resume.js';
import { registerChargeCardCommand } from '../src/payments/charge-card.js';
import { registerChargeCardResumeCommand } from '../src/payments/charge-card-resume.js';
import { registerRefundCommand } from '../src/payments/refund.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from '../../token-cli/tests/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// provider_id 收单门店按供应商路由 —— payment-cli 侧的字段透传
//
// 两条命令接受 `--provider-id`，语义不同但透传规则相同（原样进请求体 `provider_id`）：
//
// - `payments capture`（POST /pay，按令牌扣款）：**重述**。门店始终来自令牌文档，给了只参与
//   一致性校验，不一致由平台以 409 PROVIDER_MISMATCH 拒付；永不改写令牌（AC-1.3）。
// - `payments charge-card`（POST /charge/card，裸卡独立支付）：**本笔声明**。没有令牌可继承，
//   门店就取本笔声明值（AC-1.2）。
//
// 三条命令**不接受**该 flag：`payments refund`（门店跟随原扣款流水，AC-1.4 / AC-9.2）、
// `payments capture-resume` 与 `payments charge-card-resume`（门店从占位流水读）。
//
// 「省略」与「声明了无效值」是两件事：判据是 flag 有没有出现，不是真值判断。空串原样上送，
// 由平台 fail-closed（AC-2.4）——CLI 折叠成「没声明」会让这笔款悄悄落到默认门店，或让一次
// 矛盾的重述漏过校验。
//
// Validates: AC-1.2, AC-1.3, AC-1.4, AC-2.4, AC-9.2, AC-11.1
// ============================================================

/** 一个已为该 developer 配好映射的承接供应商标识。 */
const PROVIDER_ID = 'flink';

/** 别仓形态的字段名：请求体里一个都不许出现（AC-11.1）。 */
const FOREIGN_SHAPES = ['providerId', 'provider-id'] as const;

const CHARGE_RESULT = {
  charge_no: 'chg_abc123',
  payment_brand: 'evo',
  amount_cents: 1200,
  fee_cents: 0,
  total_cents: 1200,
  currency: 'USD',
  pay_status: 'success',
  merchant_trans_id: 'M001',
  evo_trans_id: 'E001',
};

const CARD_CHARGE_REQUIRES_ACTION = {
  charge_no: 'chg_evo1',
  status: 'requires_action',
  amount_cents: 4433,
  currency: 'USD',
  payment_brand: 'evo',
  three_ds_url: 'https://3ds.example/challenge',
  merchant_trans_id: 'sc_1',
};

const REFUND_RESULT = {
  refund_no: 'rfd_1',
  charge_no: 'chg_evo1',
  refunded_cents: 4433,
  currency: 'USD',
  status: 'success',
  merchant_trans_id: 'sc_1',
  evo_trans_id: 'E3',
};

// ------------------------------------------------------------
// payments capture —— §23 按令牌扣款的「重述」
// ------------------------------------------------------------

describe('payments capture — --provider-id 重述透传 (AC-1.3)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', 'capture',
    '--api-key', 'sk_key',
    '--payment-token-id', 'ptk_abc',
    '--idempotency-key', 'idem_1',
    '--yes',
    ...extra,
  ];

  function run(extra: string[]) {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);
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

  it('没给则整个 provider_id 字段不发（按令牌声明值执行）', async () => {
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
// payments charge-card —— §12 裸卡独立支付的「本笔声明」
// ------------------------------------------------------------

describe('payments charge-card — --provider-id 透传 (AC-1.2)', () => {
  const baseArgs = (extra: string[]) => [
    'node', 'cli', 'charge-card',
    '--api-key', 'sk_key',
    '--payment-method-id', 'pm_1',
    '--amount-cents', '4433',
    '--cardholder-phone', '+14155551234',
    '--idempotency-key', 'idem_1',
    '--yes',
    ...extra,
  ];

  function run(extra: string[]) {
    const apiClient = mockApiClient({ '/charge/card': CARD_CHARGE_REQUIRES_ACTION });
    const program = buildProgram();
    registerChargeCardCommand(program, { apiClient } as any);
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

  it('没给则整个 provider_id 字段不发（落默认门店）', async () => {
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
// 否定面：refund 与两条 resume 都不接受该 flag
// ------------------------------------------------------------

describe('payments refund — 不接受 --provider-id (AC-1.4 / AC-9.2)', () => {
  it('help 里不含 --provider-id', () => {
    const program = buildProgram();
    registerRefundCommand(program, { apiClient: mockApiClient() } as any);
    expect(program.commands[0].helpInformation()).not.toContain('--provider-id');
  });

  it('一次正常退款的请求体不含 provider_id（门店跟随原扣款流水）', async () => {
    const apiClient = mockApiClient({ '/refund': REFUND_RESULT });
    const program = buildProgram();
    registerRefundCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'refund',
      '--api-key', 'sk_key',
      '--charge-no', 'chg_evo1',
      '--idempotency-key', 'idem_r1',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('provider_id');
  });
});

describe('payments capture-resume / charge-card-resume — 不接受 --provider-id', () => {
  it('capture-resume 的 help 里不含 --provider-id（门店从占位流水读）', () => {
    const program = buildProgram();
    registerCaptureResumeCommand(program, { apiClient: mockApiClient() } as any);
    expect(program.commands[0].helpInformation()).not.toContain('--provider-id');
  });

  it('charge-card-resume 的 help 里不含 --provider-id（门店从占位流水读）', () => {
    const program = buildProgram();
    registerChargeCardResumeCommand(program, { apiClient: mockApiClient() } as any);
    expect(program.commands[0].helpInformation()).not.toContain('--provider-id');
  });
});

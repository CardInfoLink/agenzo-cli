import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerPayCommand } from '../src/payments/capture.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from '../../token-cli/tests/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

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

describe('capture', () => {
  it('happy path: POST /pay with payment_token_id, no payment_brand in body (auto-detected server-side)', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/pay',
      { type: 'api-key', key: 'sk_key' },
      { payment_token_id: 'ptk_abc' },
      { 'Idempotency-Key': 'idem_1' },
    );

    const output = out.text();
    expect(output).toContain('chg_abc123');
    expect(output).toContain('success');
  });

  it('request body does not include amount or currency (taken from the token)', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_2',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('currency');
  });

  it('--payment-brand override is forwarded when provided', async () => {
    const apiClient = mockApiClient({ '/pay': { ...CHARGE_RESULT, payment_brand: 'unionpay' } });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_upi',
      '--payment-brand', 'unionpay',
      '--idempotency-key', 'idem_3',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body.payment_brand).toBe('unionpay');
  });

  it('rejects an unknown --payment-brand value', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'capture',
        '--api-key', 'sk_key',
        '--payment-token-id', 'ptk_abc',
        '--payment-brand', 'visa',
        '--idempotency-key', 'idem_4',
        '--yes',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('missing --idempotency-key in --yes mode throws IdempotencyKeyRequiredError', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', 'capture',
        '--api-key', 'sk_key',
        '--payment-token-id', 'ptk_abc',
        '--yes',
      ]),
    ).rejects.toThrow();

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('--format json emits parseable JSON', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_5',
      '--yes',
      '--format', 'json',
    ]);

    const parsed = JSON.parse(out.text().trim()) as Record<string, unknown>;
    expect(parsed.charge_no).toBe('chg_abc123');
    expect(parsed.pay_status).toBe('success');
  });

  it('optional --description is forwarded when provided', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_6',
      '--description', 'ride fare',
      '--yes',
    ]);

    const body = apiClient.post.mock.calls[0][2];
    expect(body.description).toBe('ride fare');
  });
});

// ============================================================
// capture — --member (归属校验)
// ============================================================
//
// 为什么锁这个契约：平台的 `POST /pay` **只在请求带了 member_id 时才核对令牌归属**，不带则沿用
// 老行为（对其它调用方向后兼容）。所以编排器一侧不带 member 等于没核 —— 知道别人令牌 id 的人
// 就能直接扣别人的卡。编排器因此对所有按令牌扣款的 verb 统一从已认证会话注入它
// （-base schema 的 `identity.inject: member`，覆盖 charge / charge-token / visa-charge /
// evo-charge / evo-charge-auth 五个 verb，它们都落到本命令）。
//
// 而本命令此前**没有** member 相关选项（同目录的 `charge-card` 有 `--member-id`），于是编排器
// 发来的 `--member` 被 commander 判 `error: unknown option '--member'`，**整个独立支付域的
// 网络令牌扣款全部失败**（2026-10-10 实测）。失败还会被归成 `cli_failed`、落到基建兜底文案
// 「服务暂时不可用」，把接口不匹配伪装成可重试的服务故障。
//
// 透传规则与 `charge-card` 及 token-cli 各命令一致：给了非空值就作为 `member_id` 进 body，
// 空/空白整个字段不发（不发 `""`——归属是否必需由服务端判定，CLI 只负责透传）。

describe('capture — --member', () => {
  it('给了就作为 member_id 进请求体', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--member', 'test-user-036',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/pay',
      expect.anything(),
      expect.objectContaining({ payment_token_id: 'ptk_abc', member_id: 'test-user-036' }),
      expect.anything(),
    );
  });

  it('没给则整个 member_id 字段不发', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    const body = (apiClient.post as any).mock.calls[0][2] as Record<string, unknown>;
    expect('member_id' in body).toBe(false);
  });

  it('空白值等同于没给（不发 member_id: ""）', async () => {
    const apiClient = mockApiClient({ '/pay': CHARGE_RESULT });
    const program = buildProgram();
    registerPayCommand(program, { apiClient } as any);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'capture',
      '--api-key', 'sk_key',
      '--payment-token-id', 'ptk_abc',
      '--member', '   ',
      '--idempotency-key', 'idem_1',
      '--yes',
    ]);

    const body = (apiClient.post as any).mock.calls[0][2] as Record<string, unknown>;
    expect('member_id' in body).toBe(false);
  });
});

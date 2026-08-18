/**
 * `--member` 在 CLI 侧**一律不必填**（Drop-in 与 UnionPay 都一样）。
 *
 * 归属是否必需由服务端判定：UnionPay 的 `consumer_identity_value` 由 `member_id` 派生，
 * 缺失会被平台以 `INVALID_REQUEST` 拒绝；Drop-in 则允许无归属（落一张 developer 维度的
 * 卡，只在下单不传 member 时可选中）。把服务端规则复制到 CLI 会造成两处规则漂移，也让
 * "某些接入方就是不需要归属"无从表达，所以 CLI 只做透传。
 *
 * 透传规则：给了非空值就带上 `member_id`，空/空白则整个字段不发（不发 `""`——平台对空白
 * 值返回 422，发空串等于把"没传"变成一个参数错误）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

import { registerDropinCreateCommand } from '../src/payment-methods/dropin-create.js';
import { pmAddSchema } from '../src/verb-schema.js';
import { buildProgram, captureStdout, captureStderr } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

function dropinApi() {
  return {
    post: vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'pm_dropin', session_id: 'sess_1', status: 'PENDING' },
    }),
    get: vi.fn(),
  };
}

function program(api: ReturnType<typeof dropinApi>) {
  const p = buildProgram();
  registerDropinCreateCommand(p.command('payment-methods'), {
    apiClient: api as unknown as ApiClient,
  });
  return p;
}

const BASE = ['node', 'cli', 'payment-methods', 'dropin-create',
  '--api-key', 'k', '--email', 'u@example.com', '--yes'];

describe('dropin-create --member（可选，仅透传）', () => {
  it('给了就作为 member_id 上传', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE, '--member', 'usr_1']);

    expect(api.post).toHaveBeenCalledWith(
      '/payment-methods/dropin/create',
      { type: 'api-key', key: 'k' },
      { email: 'u@example.com', member_id: 'usr_1' },
    );
  });

  it('两端空白被 trim', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE, '--member', '  usr_1  ']);

    expect(api.post.mock.calls[0][2]).toEqual({
      email: 'u@example.com',
      member_id: 'usr_1',
    });
  });

  it('不给 --member 时照常请求，字段整个不发（不是 ""）', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE]);

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0][2]).toEqual({ email: 'u@example.com' });
  });

  it('--member 为纯空白等同于没给，不发空串', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE, '--member', '   ']);

    expect(api.post.mock.calls[0][2]).toEqual({ email: 'u@example.com' });
  });
});

describe('pmAddSchema', () => {
  it('member 不是 required —— CLI 边界不复制服务端规则', () => {
    expect(pmAddSchema.flags.member.required).toBe(false);
    // 值由执行层（orchestrator）从已验签身份注入，不给 LLM 自己填。
    expect(pmAddSchema.flags.member.source).toBe('session');
  });
});

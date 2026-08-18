/**
 * `--member` 在 Drop-in 绑卡写入口是**必填**（与 unionpay-enroll 同一规矩）。
 *
 * 为什么必填：查卡按 `--member <id>` 过滤，选卡也按 member 收窄且**已无回退**，所以
 * 一张 `member_id` 为空的卡既列不出来、也不能给那个终端用户扣款——静默接受等于发一张
 * 持有者自己用不了的卡。平台侧同步拒绝缺失的 member_id（INVALID_REQUEST）。
 *
 * `--yes`（非交互 / agent 驱动）下缺失必须是硬错误，不能退化成交互提示后挂住。
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

describe('dropin-create --member 必填', () => {
  it('带 --member 时作为 member_id 上传', async () => {
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

  it('--member 两端空白被 trim', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE, '--member', '  usr_1  ']);

    expect(api.post.mock.calls[0][2]).toEqual({
      email: 'u@example.com',
      member_id: 'usr_1',
    });
  });

  it('--yes 下缺 --member 是硬错误，且不发请求', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await expect(program(api).parseAsync([...BASE])).rejects.toMatchObject({
      code: 'PARAM_INVALID',
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('--member 为纯空白同样被拒，不落无归属卡', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await expect(
      program(api).parseAsync([...BASE, '--member', '   ']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('pmAddSchema', () => {
  it('member 声明为 required，agent 才知道非传不可', () => {
    expect(pmAddSchema.flags.member.required).toBe(true);
    // 值由执行层（orchestrator）从已验签身份注入，不给 LLM 自己填。
    expect(pmAddSchema.flags.member.source).toBe('session');
  });
});

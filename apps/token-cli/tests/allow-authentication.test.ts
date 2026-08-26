/**
 * `dropin-create --allow-authentication` 在 CLI 侧只做透传。
 *
 * 语义归服务端：该开关让 Evo 在 Drop-in 流程里跑持卡人认证（3DS / FIDO passkey 页），
 * Visa 令牌化必须要它 —— 不开 Evo 就不返回 `networkToken.tokenID`，卡进不了 VIC。
 * CLI 不判断"什么时候该开"，也不因为绑的是 Visa 卡就自动开：绑卡时 CLI 还没有卡信息
 * （PAN 在浏览器里由 Drop-in SDK 收），无从判断卡组织。
 *
 * 透传规则：只在显式传了 flag 时带 `allow_authentication: true`，否则整个字段不发，
 * 使既有 Evo 绑卡的请求体逐字节不变。
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

describe('dropin-create --allow-authentication（可选，仅透传）', () => {
  it('给了就带 allow_authentication: true', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE, '--allow-authentication']);

    expect(api.post).toHaveBeenCalledWith(
      '/payment-methods/dropin/create',
      { type: 'api-key', key: 'k' },
      { email: 'u@example.com', allow_authentication: true },
    );
  });

  it('不给时字段整个不发，既有 Evo 请求体不变', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE]);

    expect(api.post.mock.calls[0][2]).toEqual({ email: 'u@example.com' });
  });

  it('可与 --member 同时使用', async () => {
    const api = dropinApi();
    captureStdout();
    captureStderr();

    await program(api).parseAsync([...BASE, '--member', 'usr_1', '--allow-authentication']);

    expect(api.post.mock.calls[0][2]).toEqual({
      email: 'u@example.com',
      member_id: 'usr_1',
      allow_authentication: true,
    });
  });
});

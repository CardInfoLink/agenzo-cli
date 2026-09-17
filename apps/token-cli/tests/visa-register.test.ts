import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerVisaRegisterCommand } from '../src/visa/register.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// register 在这些测试里全程 --yes（所有必填由 flag 给全）+ --api-key 直传，
// 不应触发交互 prompt。防御性 mock，漏走的分支会以坏值暴露而不是挂起。
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('x'),
  input: vi.fn().mockResolvedValue('mocked_input'),
  password: vi.fn().mockResolvedValue('mocked_password'),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const REG = {
  developer_id: 'dev_001',
  relationship_id: 'AGZ0123456789012',
  visa_agent_id: 'va_1',
};

describe('visa register — request body & auth', () => {
  it('maps flags to the AgentBusinessProfile body and POSTs /visa/register with api-key auth (no developer_id in path)', async () => {
    const apiClient = mockApiClient({ '/visa/register': REG });
    const program = buildProgram();
    const cmd = program.command('visa');
    registerVisaRegisterCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'visa', 'register',
      '--api-key', 'sk_key',
      '--company-legal-name', 'Nine Dragons Robotics Limited',
      '--website-url', 'https://nine-dragons.example.com',
      '--company-city', 'Hong Kong',
      '--company-country-code', 'HK',
      '--contact-email', 'wing@nine-dragons.example.com',
      '--business-id-type', 'HKBR',
      '--business-id-value', '87654321-321',
      '--company-phone', '85298765432',
    ]);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    const call = apiClient.post.mock.calls[0];
    // 路径不带 developer_id（从 API Key 上下文解析）
    expect(call[0]).toBe('/visa/register');
    // api-key 鉴权
    expect(call[1]).toMatchObject({ type: 'api-key', key: 'sk_key' });
    // body 键名对齐 platform 的 AgentBusinessProfile
    expect(call[2]).toMatchObject({
      company_legal_name: 'Nine Dragons Robotics Limited',
      website_url: 'https://nine-dragons.example.com',
      company_city: 'Hong Kong',
      company_country_code: 'HK',
      contact_email: 'wing@nine-dragons.example.com',
      business_identification_type: 'HKBR',
      business_identification_value: '87654321-321',
      company_phone: '85298765432',
    });
    // 未给的 Optional 字段不进 body
    expect(call[2].company_address2).toBeUndefined();
    expect(call[2].contact_first_name).toBeUndefined();
  });

  it('requires the 6 mandatory fields locally (commander --requiredOption)', async () => {
    const apiClient = mockApiClient({ '/visa/register': REG });
    const program = buildProgram();
    const cmd = program.command('visa');
    registerVisaRegisterCommand(cmd, { apiClient } as any);
    captureStdout();
    captureStderr();

    // 缺 --business-id-value → commander 本地报错，不发网络请求
    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'visa', 'register',
        '--api-key', 'sk_key',
        '--company-legal-name', 'X', '--website-url', 'https://x.com',
        '--company-city', 'HK', '--company-country-code', 'HK',
        '--contact-email', 'a@b.com', '--business-id-type', 'HKBR',
      ]),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

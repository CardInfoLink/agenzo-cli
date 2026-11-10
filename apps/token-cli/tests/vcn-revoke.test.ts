import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerRevokeCommand } from '../src/payment-tokens/revoke.js';
import { registerListCommand } from '../src/payment-tokens/list.js';
import { buildProgram, captureStdout, captureStderr } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

const REVOKED_VCN = {
  id: 'ptk_vcn_1',
  status: 'REVOKED',
  revoked_at: '2026-11-10T03:00:00Z',
  vcn: { settlement: { consumed_cents: 300, fee_cents: 112, refunded_cents: 588 } },
};

function apiClientFor(data: unknown) {
  return {
    get: vi.fn().mockResolvedValue({ success: true, data }),
    post: vi.fn().mockResolvedValue({ success: true, data }),
  };
}

async function run(register: typeof registerRevokeCommand, apiClient: unknown, args: string[]) {
  const program = buildProgram();
  register(program.command('payment-tokens'), { apiClient } as any);
  const out = captureStdout();
  captureStderr();
  await program.parseAsync(['node', 'cli', 'payment-tokens', ...args, '--api-key', 'sk_key']);
  return out;
}

describe('payment-tokens revoke (flag-only callers)', () => {
  it('takes the id from --id and scopes the revoke to --member', async () => {
    const apiClient = apiClientFor(REVOKED_VCN);
    await run(registerRevokeCommand, apiClient, [
      'revoke', '--id', 'ptk_vcn_1', '--member', 'm_1', '--idempotency-key', 'ptk_vcn_1',
    ]);

    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/ptk_vcn_1/revoke?member_id=m_1',
      expect.anything(),
      undefined,
      { 'Idempotency-Key': 'ptk_vcn_1' },
    );
  });

  it('rejects a missing id before any request', async () => {
    const apiClient = apiClientFor(REVOKED_VCN);
    await expect(
      run(registerRevokeCommand, apiClient, ['revoke', '--idempotency-key', 'k']),
    ).rejects.toThrow();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('prints the VCN settlement after revoking', async () => {
    const out = await run(registerRevokeCommand, apiClientFor(REVOKED_VCN), [
      'revoke', 'ptk_vcn_1', '--idempotency-key', 'k',
    ]);

    expect(out.text()).toContain('Refunded');
    expect(out.text()).toContain('5.88');
    expect(out.text()).toContain('1.12');
  });
});

describe('payment-tokens list --status', () => {
  it('sends status upper-cased with type and member', async () => {
    const apiClient = apiClientFor([]);
    await run(registerListCommand, apiClient, ['list', '--type', 'vcn', '--member', 'm_1', '--status', 'active']);

    expect(apiClient.get.mock.calls[0][2]).toEqual({ type: 'vcn', member_id: 'm_1', status: 'ACTIVE' });
  });
});

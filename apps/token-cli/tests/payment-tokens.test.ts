import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerListCommand } from '../src/payment-tokens/list.js';
import { registerGetCommand } from '../src/payment-tokens/get.js';
import { registerRevokeCommand } from '../src/payment-tokens/revoke.js';
import { registerCreateCommand } from '../src/payment-tokens/create.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// Mock @inquirer/prompts to avoid interactive prompts in create tests
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
// payment-tokens list (§3.4.2)
// ============================================================

describe('payment-tokens list', () => {
  const VCN_TOKEN = { id: 'pt_vcn_001', type: 'vcn', status: 'ACTIVE', first6: '411111', last4: '1234', amount_limit: 2500 };
  const NT_TOKEN = { id: 'pt_nt_001', type: 'network_token', status: 'ACTIVE', network_token: { payment_brand: 'Visa' } };
  const X402_TOKEN = { id: 'pt_x402_001', type: 'x402', status: 'ACTIVE', amount: '1000000', network: 'Base' };

  it('happy path: GET /payment-tokens with table output and getSummary', async () => {
    const apiClient = mockApiClient({ '/payment-tokens': [VCN_TOKEN, NT_TOKEN, X402_TOKEN] });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'list', '--api-key', 'sk_key']);

    // Verify API call
    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-tokens',
      { type: 'api-key', key: 'sk_key' },
      undefined,
    );

    const output = out.text();
    // Table headers
    expect(output).toContain('Token ID');
    expect(output).toContain('Type');
    expect(output).toContain('Status');
    expect(output).toContain('Summary');

    // VCN summary: first6****last4 $limit/100
    expect(output).toContain('pt_vcn_001');
    expect(output).toContain('411111****1234');
    expect(output).toContain('$25.00');

    // Network token summary: brand
    expect(output).toContain('pt_nt_001');
    expect(output).toContain('Visa');

    // X402 summary: amount network
    expect(output).toContain('pt_x402_001');
    expect(output).toContain('1000000 Base');
  });

  it('empty list outputs info message without table', async () => {
    const apiClient = mockApiClient({ '/payment-tokens': [] });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerListCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'list', '--api-key', 'sk_key']);

    const output = out.text();
    expect(output).toContain('No payment tokens found');
    expect(output).not.toMatch(/Token ID\s+Type\s+Status/);
  });

  it('passes --type and --member as query params', async () => {
    const apiClient = mockApiClient({ '/payment-tokens': [] });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerListCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'list', '--api-key', 'sk_key', '--type', 'vcn', '--member', 'mem_1']);

    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-tokens',
      { type: 'api-key', key: 'sk_key' },
      { type: 'vcn', member_id: 'mem_1' },
    );
  });
});

// ============================================================
// payment-tokens get (§3.4.3) — Property 7 differences
// ============================================================

describe('payment-tokens get', () => {
  it('happy path: VCN keyValue masks PAN/CVC by default, uses "Token ID", includes Last 4, Limit without $', async () => {
    const vcnData = {
      id: 'pt_vcn_get',
      type: 'vcn',
      vcn: {
        card_number: '4111111111111111',
        last_four: '1111',
        expiry: '1228',
        cvc: '999',
        amount_limit: 2500,
        balance: 2000,
        currency: 'USD',
        status: 'ACTIVE',
      },
    };
    const apiClient = mockApiClient({ '/payment-tokens/pt_vcn_get': vcnData });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'get', 'pt_vcn_get', '--api-key', 'sk_key']);

    // Verify API call
    expect(apiClient.get).toHaveBeenCalledWith(
      '/payment-tokens/pt_vcn_get',
      { type: 'api-key', key: 'sk_key' },
    );

    const output = out.text();
    // Property 7: key is "Token ID" not "Payment Token ID"
    expect(output).toContain('Token ID');
    expect(output).not.toContain('Payment Token ID');

    // Property 7: VCN get includes "Last 4"
    expect(output).toContain('Last 4');
    expect(output).toContain('1111');

    // Sensitive VCN values are masked unless --reveal is explicitly supplied.
    expect(output).toContain('************1111');
    expect(output).toContain('***');
    expect(output).not.toContain('4111111111111111');
    expect(output).not.toContain('999');

    // Property 7: Limit and Balance without $ prefix
    expect(output).toContain('Limit');
    expect(output).toContain('25.00');
    expect(output).not.toMatch(/\$25\.00/);

    expect(output).toContain('Balance');
    expect(output).toContain('20.00');
    expect(output).not.toMatch(/\$20\.00/);
  });

  it('--reveal shows full VCN card number and CVC', async () => {
    const vcnData = {
      id: 'pt_vcn_reveal',
      type: 'vcn',
      vcn: {
        card_number: '4111111111111111',
        last_four: '1111',
        expiry: '1228',
        cvc: '999',
        amount_limit: 2500,
        balance: 2000,
        currency: 'USD',
        status: 'ACTIVE',
      },
    };
    const apiClient = mockApiClient({ '/payment-tokens/pt_vcn_reveal': vcnData });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', 'payment-tokens', 'get', 'pt_vcn_reveal',
      '--api-key', 'sk_key',
      '--reveal',
    ]);

    const output = out.text();
    expect(output).toContain('4111111111111111');
    expect(output).toContain('999');
  });

  it('json output masks VCN card number and CVC unless --reveal is supplied', async () => {
    const vcnData = {
      id: 'pt_vcn_json_get',
      type: 'vcn',
      vcn: {
        card_number: '4111111111111111',
        last_four: '1111',
        expiry: '1228',
        cvc: '999',
        amount_limit: 2500,
        balance: 2000,
        currency: 'USD',
        status: 'ACTIVE',
      },
    };
    const apiClient = mockApiClient({ '/payment-tokens/pt_vcn_json_get': vcnData });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--format', 'json', 'payment-tokens', 'get', 'pt_vcn_json_get',
      '--api-key', 'sk_key',
    ]);

    const json = JSON.parse(out.text().trim());
    expect(json.vcn.card_number).toBe('************1111');
    expect(json.vcn.cvc).toBe('***');
    expect(out.text()).not.toContain('4111111111111111');
    expect(out.text()).not.toContain('999');
  });

  it('network_token keyValue output', async () => {
    const ntData = {
      id: 'pt_nt_get',
      type: 'network_token',
      network_token: {
        payment_brand: 'Visa',
        first6No: '400000',
        last4No: '9999',
        eci: '05',
        token_cryptogram: 'AAAA',
        expiry_date: '1230',
        value: '4000009999991111',
      },
    };
    const apiClient = mockApiClient({ '/payment-tokens/pt_nt_get': ntData });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'get', 'pt_nt_get', '--api-key', 'sk_key']);

    const output = out.text();
    expect(output).toContain('Token ID');
    expect(output).toContain('pt_nt_get');
    expect(output).toContain('Network Token');
    expect(output).toContain('Visa');
    expect(output).toContain('05');
    expect(output).toContain('AAAA');
    expect(output).toContain('1230');
    expect(output).toContain('4000009999991111');
  });

  it('x402 keyValue output', async () => {
    const x402Data = {
      id: 'pt_x402_get',
      type: 'x402',
      x402: {
        signature_value: 'sig_0xabc123',
        status: 'ACTIVE',
      },
    };
    const apiClient = mockApiClient({ '/payment-tokens/pt_x402_get': x402Data });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerGetCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'get', 'pt_x402_get', '--api-key', 'sk_key']);

    const output = out.text();
    expect(output).toContain('Token ID');
    expect(output).toContain('pt_x402_get');
    expect(output).toContain('X402');
    expect(output).toContain('sig_0xabc123');
    expect(output).toContain('ACTIVE');
  });
});

// ============================================================
// payment-tokens revoke (§3.4.4)
// ============================================================

describe('payment-tokens revoke', () => {
  it('happy path: immediate revoke — POST /payment-tokens/<id>/revoke with output', async () => {
    const revokeResult = { id: 'pt_rev', status: 'REVOKED', revoked_at: '2026-01-15T12:00:00Z', expires_at: null };
    const apiClient = mockApiClient({ '/payment-tokens/pt_rev/revoke': revokeResult });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerRevokeCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'revoke', 'pt_rev', '--api-key', 'sk_key', '--idempotency-key', 'idem_rev']);

    // Verify POST
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/pt_rev/revoke',
      { type: 'api-key', key: 'sk_key' },
      undefined,
      { 'Idempotency-Key': 'idem_rev' },
    );

    // Verify output
    const stderrText = err.text();
    expect(stderrText).toContain('Payment token revoked');

    const output = out.text();
    expect(output).toContain('pt_rev');
    expect(output).toContain('REVOKED');
    expect(output).toContain('Revoked At');
  });

  it('delayed revoke (X402): status ACTIVE + expires_at → scheduled message', async () => {
    const revokeResult = { id: 'pt_x402_del', status: 'ACTIVE', expires_at: '2026-01-20T00:00:00Z', revoked_at: null, message: 'Will expire at deadline' };
    const apiClient = mockApiClient({ '/payment-tokens/pt_x402_del/revoke': revokeResult });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerRevokeCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'payment-tokens', 'revoke', 'pt_x402_del', '--api-key', 'sk_key', '--idempotency-key', 'idem_del']);

    const stderrText = err.text();
    expect(stderrText).toContain('Revoke scheduled (cryptogram will auto-expire)');

    const output = out.text();
    expect(output).toContain('pt_x402_del');
    expect(output).toContain('ACTIVE');
    expect(output).toContain('Expires At');
    expect(output).toContain('Will expire at deadline');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = mockApiClient();
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerRevokeCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', '--yes', 'payment-tokens', 'revoke', 'pt_001', '--api-key', 'sk_key']),
    ).rejects.toThrow('--idempotency-key');

    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// payment-tokens create (§3.4.1) — type mapping + key branches
// ============================================================

describe('payment-tokens create', () => {
  it('VCN: correct type mapping, body assembly, and output', async () => {
    const vcnResponse = {
      id: 'pt_vcn_new',
      type: 'vcn',
      vcn: { card_number: '4111222233334444', expiry_date: '1230', cvc: '111', amount_limit: 2500, currency: 'USD', status: 'ACTIVE' },
    };
    // Need: /features/vcn (gate check), /payment-methods (resolve PM), /payment-tokens/create
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/features/vcn') {
          return Promise.resolve({ success: true, data: { enabled: true } });
        }
        if (path === '/payment-methods') {
          return Promise.resolve({ success: true, data: [{ id: 'pm_single', status: 'ACTIVE', last4: '1234' }] });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({ success: true, data: vcnResponse }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'create',
      '--api-key', 'sk_key',
      '--type', 'vcn',
      '--payment-method-id', 'pm_explicit',
      '--amount', '25.00',
      '--idempotency-key', 'idem_vcn',
    ]);

    // Verify POST body
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/create',
      { type: 'api-key', key: 'sk_key' },
      expect.objectContaining({
        type: 'vcn', // mapped from 'vcn' → 'vcn' (unchanged)
        payment_method_id: 'pm_explicit',
        amount: 2500, // 25.00 USD → 2500 cents
      }),
      { 'Idempotency-Key': 'idem_vcn' },
    );

    // §3.4.1: --currency omitted → currency must NOT be in the request body
    const vcnBody = apiClient.post.mock.calls[0][2];
    expect(vcnBody).not.toHaveProperty('currency');

    // Verify output
    const stderrText = err.text();
    expect(stderrText).toContain('Payment token created');

    const output = out.text();
    expect(output).toContain('pt_vcn_new');
    expect(output).toContain('VCN');
    expect(output).toContain('Payment Token ID');
  });

  it('Network Token: type "network-token" maps to "network_token"', async () => {
    const ntResponse = {
      id: 'pt_nt_new',
      type: 'network_token',
      network_token: { payment_brand: 'Visa', first6No: '400000', last4No: '1234', eci: '05', token_cryptogram: 'AAA', expiry_date: '1230', value: '4000001234' },
    };
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/config/network-token-fee') {
          return Promise.resolve({ success: true, data: { fee_cents: 500 } });
        }
        if (path === '/payment-methods') {
          return Promise.resolve({ success: true, data: [{ id: 'pm_single', status: 'ACTIVE', last4: '1234' }] });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({ success: true, data: ntResponse }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'create',
      '--api-key', 'sk_key',
      '--type', 'network-token',
      '--payment-method-id', 'pm_nt',
      '--idempotency-key', 'idem_nt',
    ]);

    // Verify type mapping: 'network-token' → 'network_token' in body
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/create',
      { type: 'api-key', key: 'sk_key' },
      expect.objectContaining({
        type: 'network_token',
        payment_method_id: 'pm_nt',
      }),
      { 'Idempotency-Key': 'idem_nt' },
    );

    const output = out.text();
    expect(output).toContain('Network Token');
    expect(output).toContain('Visa');
  });

  it('X402: type mapping unchanged, includes signature value and info message', async () => {
    const x402Response = {
      id: 'pt_x402_new',
      type: 'x402',
      x402: { signature_value: '0xdeadbeef', status: 'ACTIVE' },
    };
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/payment-methods') {
          return Promise.resolve({ success: true, data: [{ id: 'pm_single', status: 'ACTIVE', last4: '1234' }] });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn().mockResolvedValue({ success: true, data: x402Response }),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'create',
      '--api-key', 'sk_key',
      '--type', 'x402',
      '--payment-method-id', 'pm_x402',
      '--amount', '1.00',
      '--pay-to', '0xRecipient',
      '--nonce', '42',
      '--network', 'Base',
      '--deadline', '1700000000',
      '--idempotency-key', 'idem_x402',
    ]);

    // Verify type mapping: 'x402' stays 'x402'
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payment-tokens/create',
      { type: 'api-key', key: 'sk_key' },
      expect.objectContaining({
        type: 'x402',
        payment_method_id: 'pm_x402',
        pay_to: '0xRecipient',
        nonce: '42',
        network: 'Base',
        deadline: 1700000000, // §3.4.1: sent as number, not string
      }),
      { 'Idempotency-Key': 'idem_x402' },
    );

    // X402 should include info message about X-PAYMENT header
    const output = out.text();
    expect(output).toContain('X402');
    expect(output).toContain('0xdeadbeef');
    expect(output).toContain('Use the Signature Value in the X-PAYMENT request header');
  });

  it('requires --idempotency-key in --yes mode', async () => {
    const apiClient = {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === '/features/vcn') {
          return Promise.resolve({ success: true, data: { enabled: true } });
        }
        if (path === '/payment-methods') {
          return Promise.resolve({ success: true, data: [{ id: 'pm_single', status: 'ACTIVE', last4: '1234' }] });
        }
        return Promise.resolve({ success: true, data: {} });
      }),
      post: vi.fn(),
    };

    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'create',
        '--api-key', 'sk_key',
        '--type', 'vcn',
        '--payment-method-id', 'pm_001',
        '--amount', '10.00',
      ]),
    ).rejects.toThrow('--idempotency-key');

    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

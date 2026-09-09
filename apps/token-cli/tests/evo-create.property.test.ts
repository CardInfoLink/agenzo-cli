import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerEvoCreateCommand } from '../src/payment-tokens/evo-create.js';
import { buildProgram, captureStdout, captureStderr, mockApiClient } from './helpers.js';

// evo-create runs entirely in --yes mode in these tests (all required flags
// supplied), so no interactive prompt should ever fire. Mock @inquirer/prompts
// defensively so a missed branch surfaces as a bad value rather than a hang.
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

/**
 * An ACTIVE EVO network-token response — the expected happy-path shape. EVO
 * minting is synchronous ACTIVE with cryptogram and **NO URL** (cardholder auth
 * happened at Drop-in binding), so the fixture deliberately carries neither a
 * payment_url nor a checkout_url.
 */
const EVO_ACTIVE = {
  id: 'ptk_evo_001',
  type: 'network_token',
  status: 'ACTIVE',
  payment_brand: 'evo',
};

// ============================================================
// payment-tokens evo-create — Property 1: amount-unit round-trip (R13.3)
// ============================================================
//
// Property 1 (金额单位往返一致 / amount-unit round-trip, EVO side):
// the integer cents supplied at the entry (`--amount-cents`) MUST land in the
// request body as the TOP-LEVEL `amount` byte-for-byte, with NO unit conversion
// whatsoever. The EVO rail carries integer cents natively (the platform writes
// this value straight into `preauth_total_cents` at mint time) and MUST NOT
// route through `cents_to_decimal` (contrast UnionPay's `unionpay_amount`, a
// two-decimal string). This matches Visa's integer-cents convention (only the
// field placement differs: EVO top-level `amount` vs Visa nested
// `visa.order_amount_cents`). These parametrized cases pin the boundary values
// called out by the spec (5→5, 100→100, 12345→12345) and assert the absence of
// any decimal / UnionPay-style / nested-visa representation anywhere in the
// payload.
// Validates: Requirements 13.3

describe('payment-tokens evo-create — Property 1: amount-unit round-trip (R13.3)', () => {
  // [entry integer cents, the decimal string it would WRONGLY become under
  // cents_to_decimal — must never appear in the EVO payload].
  const ROUND_TRIP_CASES: Array<[cents: number, wrongDecimal: string]> = [
    [5, '0.05'],
    [100, '1.00'],
    [12345, '123.45'],
  ];

  it.each(ROUND_TRIP_CASES)(
    'top-level amount == entry cents byte-for-byte with no unit conversion (%i → %i)',
    async (cents, wrongDecimal) => {
      const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
      const program = buildProgram();
      const cmd = program.command('payment-tokens');
      registerEvoCreateCommand(cmd, { apiClient } as any);

      captureStdout();
      captureStderr();

      await program.parseAsync([
        'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
        '--api-key', 'sk_key',
        '--payment-method-id', 'pm_evo_1',
        '--amount-cents', String(cents),
        '--idempotency-key', `idem_rt_${cents}`,
      ]);

      // Exactly one minting request reached the shared create endpoint.
      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.get).not.toHaveBeenCalled();
      const body = apiClient.post.mock.calls[0][2] as Record<string, any>;

      // Top-level integer cents, identical to the entry value — same number,
      // same type, no scaling. `12345 → 12345`, NOT `123.45`.
      expect(typeof body.amount).toBe('number');
      expect(Number.isInteger(body.amount)).toBe(true);
      expect(body.amount).toBe(cents);
      // Byte-for-byte: the serialized number equals the entry digits verbatim.
      expect(String(body.amount)).toBe(String(cents));

      // No decimal conversion / no alternate amount source anywhere. The EVO
      // rail's amount lives at the TOP LEVEL (unit-identical to Visa), never as
      // a nested visa object nor as the UnionPay decimal-string field.
      expect(body).not.toHaveProperty('visa'); // no nested Visa DTO on the EVO rail
      expect(body).not.toHaveProperty('order_amount_cents'); // that's Visa's nested field
      expect(body).not.toHaveProperty('unionpay_amount'); // not the UnionPay decimal-string field

      // The `cents_to_decimal` output must appear NOWHERE in the payload — the
      // strongest guard that the EVO rail did not scale the amount.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(wrongDecimal);
      expect(serialized).not.toContain('.'); // no decimal point at all in the body
    },
  );

  it('sends the amount as a top-level integer with the same unit as Visa (no visa/unionpay amount fields)', async () => {
    const apiClient = mockApiClient({ '/payment-tokens/create': EVO_ACTIVE });
    const program = buildProgram();
    const cmd = program.command('payment-tokens');
    registerEvoCreateCommand(cmd, { apiClient } as any);

    captureStdout();
    captureStderr();

    await program.parseAsync([
      'node', 'cli', '--yes', 'payment-tokens', 'evo-create',
      '--api-key', 'sk_key',
      '--payment-method-id', 'pm_evo_1',
      '--amount-cents', '12345',
      '--currency', 'USD',
      '--idempotency-key', 'idem_unit',
    ]);

    const body = apiClient.post.mock.calls[0][2] as Record<string, any>;

    // network_token mint carrying the amount at the top level in integer cents.
    expect(body).toMatchObject({
      type: 'network_token',
      payment_method_id: 'pm_evo_1',
      amount: 12345,
      currency: 'USD',
    });
    // Unit-consistency with Visa: integer cents, not a decimal string. The only
    // difference from Visa is placement (top-level vs nested), never the unit.
    expect(typeof body.amount).toBe('number');
    expect(Number.isInteger(body.amount)).toBe(true);
    expect(typeof body.currency).toBe('string');
    // EVO carries no Visa sub-object and no UnionPay decimal-string amount.
    expect(body.visa).toBeUndefined();
    expect(body.unionpay_amount).toBeUndefined();
  });
});

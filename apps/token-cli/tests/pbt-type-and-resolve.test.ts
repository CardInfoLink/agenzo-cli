import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { mapTokenType, resolvePaymentMethod } from '../src/payment-tokens/create.js';
import { CliError } from '@agenzo/cli-core';

/**
 * Property 2: type mapping is stable
 * For any `--type ∈ {vcn, network-token, x402}`, the `type` sent to the server is always
 * the corresponding value in `{vcn, network_token, x402}`; unknown values pass through unchanged.
 *
 * **Validates: Requirements 3.1**
 */
describe('Property 2: mapTokenType – type mapping is stable', () => {
  it('known type "vcn" maps to "vcn"', () => {
    expect(mapTokenType('vcn')).toBe('vcn');
  });

  it('known type "network-token" maps to "network_token"', () => {
    expect(mapTokenType('network-token')).toBe('network_token');
  });

  it('known type "x402" maps to "x402"', () => {
    expect(mapTokenType('x402')).toBe('x402');
  });

  it('PBT: any unknown string passes through unchanged', () => {
    const knownTypes = new Set(['network-token']);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !knownTypes.has(s)),
        (input) => {
          // For any non-"network-token" value, mapTokenType returns identity
          expect(mapTokenType(input)).toBe(input);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('PBT: known types always produce the correct mapping', () => {
    const mapping: [string, string][] = [
      ['vcn', 'vcn'],
      ['network-token', 'network_token'],
      ['x402', 'x402'],
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...mapping),
        ([input, expected]) => {
          expect(mapTokenType(input)).toBe(expected);
        },
      ),
      { numRuns: 50 },
    );
  });
});

/**
 * Property 3: payment method resolution priority
 * Given any (flag combination × set of ACTIVE cards), the resolution result obeys a fixed priority:
 * payment-method-id > card(last4) > single-card auto > multi-card interactive;
 * no cards always yields CLIENT_NO_PAYMENT_METHOD,
 * --card with no match always yields CLIENT_CARD_NOT_MATCHED.
 *
 * **Validates: Requirements 3.2**
 */
describe('Property 3: resolvePaymentMethod – payment method resolution priority', () => {
  const API_KEY = 'test_api_key';

  function makeApiClient(activeCards: Array<{ id: string; last4?: string; status: string }>) {
    return {
      get: vi.fn().mockResolvedValue({
        success: true,
        data: activeCards.map((c) => ({
          id: c.id,
          type: 'card',
          status: c.status,
          last4: c.last4,
          created_at: '2024-01-01T00:00:00Z',
        })),
      }),
      post: vi.fn(),
    } as any;
  }

  // Priority 1: --payment-method-id always wins, regardless of card list
  it('--payment-method-id always wins regardless of ACTIVE cards', async () => {
    const explicitId = 'pm_explicit_123';
    const apiClient = makeApiClient([
      { id: 'pm_card_1', last4: '1234', status: 'ACTIVE' },
      { id: 'pm_card_2', last4: '5678', status: 'ACTIVE' },
    ]);

    const result = await resolvePaymentMethod(apiClient, API_KEY, {
      paymentMethodId: explicitId,
      card: '1234', // should be ignored
    });

    expect(result).toBe(explicitId);
    // Should NOT call API when explicit id provided
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  // Priority 2: --card matches last4 of an ACTIVE card
  it('--card matches last4 of an ACTIVE card', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_card_1', last4: '1234', status: 'ACTIVE' },
      { id: 'pm_card_2', last4: '5678', status: 'ACTIVE' },
    ]);

    const result = await resolvePaymentMethod(apiClient, API_KEY, {
      card: '5678',
    });

    expect(result).toBe('pm_card_2');
  });

  // Priority 2 error: --card with no match → CLIENT_CARD_NOT_MATCHED
  it('--card with no matching last4 throws CLIENT_CARD_NOT_MATCHED', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_card_1', last4: '1234', status: 'ACTIVE' },
    ]);

    await expect(
      resolvePaymentMethod(apiClient, API_KEY, { card: '9999' }),
    ).rejects.toMatchObject({
      code: 'CLIENT_CARD_NOT_MATCHED',
    });
  });

  // No ACTIVE cards → CLIENT_NO_PAYMENT_METHOD
  it('no ACTIVE cards throws CLIENT_NO_PAYMENT_METHOD', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_inactive', last4: '1111', status: 'PENDING' },
    ]);

    await expect(
      resolvePaymentMethod(apiClient, API_KEY, {}),
    ).rejects.toMatchObject({
      code: 'CLIENT_NO_PAYMENT_METHOD',
    });
  });

  it('empty card list throws CLIENT_NO_PAYMENT_METHOD', async () => {
    const apiClient = makeApiClient([]);

    await expect(
      resolvePaymentMethod(apiClient, API_KEY, {}),
    ).rejects.toMatchObject({
      code: 'CLIENT_NO_PAYMENT_METHOD',
    });
  });

  // Priority 3: single ACTIVE card → auto-select (returns that card's id)
  it('single ACTIVE card auto-selects without prompting', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_only_one', last4: '4321', status: 'ACTIVE' },
    ]);

    const result = await resolvePaymentMethod(apiClient, API_KEY, {});

    expect(result).toBe('pm_only_one');
  });

  // Priority 4: multiple ACTIVE cards + --yes → throws PARAM_INVALID (can't prompt)
  it('multiple ACTIVE cards + --yes throws PARAM_INVALID (cannot prompt)', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_card_1', last4: '1111', status: 'ACTIVE' },
      { id: 'pm_card_2', last4: '2222', status: 'ACTIVE' },
    ]);

    await expect(
      resolvePaymentMethod(apiClient, API_KEY, { yes: true }),
    ).rejects.toMatchObject({
      code: 'PARAM_INVALID',
    });
  });

  // Filters only ACTIVE cards (not PENDING/DISABLED)
  it('only considers ACTIVE cards, ignores PENDING/DISABLED', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_pending', last4: '1111', status: 'PENDING' },
      { id: 'pm_disabled', last4: '2222', status: 'DISABLED' },
      { id: 'pm_active', last4: '3333', status: 'ACTIVE' },
    ]);

    // Single ACTIVE card → auto-select
    const result = await resolvePaymentMethod(apiClient, API_KEY, {});
    expect(result).toBe('pm_active');
  });

  // --card matching is exact (last4), not partial
  it('--card matching is exact on last4 value', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_card_1', last4: '12345', status: 'ACTIVE' },
      { id: 'pm_card_2', last4: '1234', status: 'ACTIVE' },
    ]);

    const result = await resolvePaymentMethod(apiClient, API_KEY, { card: '1234' });
    expect(result).toBe('pm_card_2');
  });

  // Error thrown is an instance of CliError
  it('CLIENT_NO_PAYMENT_METHOD error is a CliError instance', async () => {
    const apiClient = makeApiClient([]);

    try {
      await resolvePaymentMethod(apiClient, API_KEY, {});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe('CLIENT_NO_PAYMENT_METHOD');
    }
  });

  it('CLIENT_CARD_NOT_MATCHED error is a CliError instance', async () => {
    const apiClient = makeApiClient([
      { id: 'pm_card_1', last4: '1234', status: 'ACTIVE' },
    ]);

    try {
      await resolvePaymentMethod(apiClient, API_KEY, { card: '0000' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe('CLIENT_CARD_NOT_MATCHED');
    }
  });
});

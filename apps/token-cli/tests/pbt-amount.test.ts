import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { usdToCents } from '../src/payment-tokens/create.js';

/**
 * Property-Based Test: VCN amount string → cents with no float drift
 *
 * **Validates: Requirements 3.3**
 *
 * Design Property 1: for any valid amount string a ∈ [0.01, 500.00] (two decimal places),
 * usdToCents(a) always equals the exact cent value round(a*100).
 * Key point: usdToCents uses string parsing (split('.') + padEnd), so even for
 * values where parseFloat has precision issues (e.g. "1.005"→100.499…), it produces no float drift.
 */
describe('Property 1: amount has no float drift', () => {
  /**
   * Generate valid USD amount strings in [0.01, 500.00] with exactly 2 decimal places.
   * Strategy: compose integer part [0, 500] + fractional part [0, 99],
   * ensuring total cents is in [1, 50000].
   */
  const validAmountString = fc
    .integer({ min: 1, max: 50000 }) // cents in [1, 50000] → $0.01 to $500.00
    .map((cents) => {
      const dollars = Math.floor(cents / 100);
      const frac = cents % 100;
      return `${dollars}.${frac.toString().padStart(2, '0')}`;
    });

  it('usdToCents(a) === expected cents for any valid amount in [0.01, 500.00]', () => {
    fc.assert(
      fc.property(validAmountString, (amountStr) => {
        const result = usdToCents(amountStr);
        // Compute expected cents from the string precisely (no float involved)
        const parts = amountStr.split('.');
        const expectedCents = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
        expect(result).toBe(expectedCents);
      }),
      { numRuns: 1000 },
    );
  });

  it('usdToCents(a) === Math.round(parseFloat(a) * 100) for all valid amounts (string parsing avoids float drift)', () => {
    fc.assert(
      fc.property(validAmountString, (amountStr) => {
        const result = usdToCents(amountStr);
        // For two-decimal-place strings, Math.round(parseFloat(a)*100) is also correct
        // because the float representation of X.YZ * 100 is within 0.5 of the integer.
        // But the key insight is usdToCents NEVER uses parseFloat internally.
        expect(result).toBe(Math.round(parseFloat(amountStr) * 100));
      }),
      { numRuns: 1000 },
    );
  });

  // Edge-case examples for known problematic floating-point values
  describe('edge cases: values where parseFloat would cause drift', () => {
    it('handles "1.005" correctly (parseFloat("1.005") * 100 = 100.499...)', () => {
      // "1.005" has 3 decimal places → usdToCents validates max 2 decimal places
      // So this should throw PARAM_INVALID. The real concern is values like:
      // "0.10" where parseFloat gives 0.1 * 100 = 10.000000000000002
      // But with string parsing, we always get the exact integer.
      // Note: "1.005" is invalid input for usdToCents (3 decimal places)
      expect(() => usdToCents('1.005')).toThrow();
    });

    it('handles boundary "0.01" (minimum valid amount)', () => {
      expect(usdToCents('0.01')).toBe(1);
    });

    it('handles boundary "500.00" (maximum valid amount)', () => {
      expect(usdToCents('500.00')).toBe(50000);
    });

    it('handles whole number "1" (no decimal point)', () => {
      expect(usdToCents('1')).toBe(100);
    });

    it('handles whole number "100" (no decimal point)', () => {
      expect(usdToCents('100')).toBe(10000);
    });

    it('handles "0.10" correctly (float: 0.1 * 100 = 10.000000000000002)', () => {
      expect(usdToCents('0.10')).toBe(10);
    });

    it('handles "0.29" correctly (float: 0.29 * 100 = 28.999999999999996)', () => {
      expect(usdToCents('0.29')).toBe(29);
    });

    it('handles "1.1" (single decimal digit, padded to "10")', () => {
      expect(usdToCents('1.1')).toBe(110);
    });
  });
});

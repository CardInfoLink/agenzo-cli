import { describe, it, expect } from 'vitest';
import {
  resolveBillingMode,
  DEFAULT_BILLING_MODE,
} from '../src/developers/billing-mode.js';
import { ValidationError } from '@agenzo/cli-core';

/**
 * --billing-mode validation (cli-design §2.4.10 / §4.2.2).
 * Mirrors the keys --scope local-validation pattern: unknown values throw
 * ValidationError → PARAM_INVALID / exit 1; absent flag falls back to default.
 */
describe('resolveBillingMode', () => {
  it('defaults to pay_per_call when flag is absent', () => {
    expect(resolveBillingMode(undefined)).toBe('pay_per_call');
    expect(DEFAULT_BILLING_MODE).toBe('pay_per_call');
  });

  it('accepts pay_per_call', () => {
    expect(resolveBillingMode('pay_per_call')).toBe('pay_per_call');
  });

  it('accepts monthly_settlement', () => {
    expect(resolveBillingMode('monthly_settlement')).toBe('monthly_settlement');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(resolveBillingMode('  Monthly_Settlement ')).toBe('monthly_settlement');
  });

  it('throws ValidationError on an unknown value', () => {
    expect(() => resolveBillingMode('weekly')).toThrow(ValidationError);
  });
});

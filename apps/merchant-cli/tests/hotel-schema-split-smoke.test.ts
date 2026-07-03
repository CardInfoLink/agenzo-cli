/**
 * Schema smoke tests for hotel-redaug create-then-pay split.
 *
 * Asserts that the provider schema (hotel-redaug.json) correctly reflects the
 * two-step create-order / pay-order flow and no longer contains the combined
 * `book` verb or "in one step" language.
 *
 * **Validates: Requirements 7.6, 7.7, 10.1, 10.5**
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Load the provider schema JSON
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../../../agenzo-providers/providers/redaug/redaug_provider/schema/hotel-redaug.json',
);
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const verbs = schema.verbs as Record<string, unknown>;
const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf-8');

describe('hotel-redaug schema: create-order verb (Req 7.6)', () => {
  it('create-order verb exists', () => {
    expect(verbs).toHaveProperty('create-order');
  });

  it('create-order has flags', () => {
    const verb = verbs['create-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('flags');
    const flags = verb.flags as Record<string, unknown>;
    expect(Object.keys(flags).length).toBeGreaterThan(0);
  });

  it('create-order has response', () => {
    const verb = verbs['create-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('response');
    const response = verb.response as Record<string, unknown>;
    expect(response).toHaveProperty('order_id');
    expect(response).toHaveProperty('fc_order_code');
    expect(response).toHaveProperty('total_amount');
    expect(response).toHaveProperty('currency');
  });

  it('create-order has examples', () => {
    const verb = verbs['create-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('examples');
    const examples = verb.examples as unknown[];
    expect(examples.length).toBeGreaterThanOrEqual(1);
  });

  it('create-order has error_recovery', () => {
    const verb = verbs['create-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('error_recovery');
    const recovery = verb.error_recovery as Record<string, unknown>;
    expect(Object.keys(recovery).length).toBeGreaterThan(0);
    // Should include key error codes
    expect(recovery).toHaveProperty('NO_AVAILABILITY');
    expect(recovery).toHaveProperty('PRICE_CHANGED');
  });
});

describe('hotel-redaug schema: pay-order verb (Req 7.7)', () => {
  it('pay-order verb exists', () => {
    expect(verbs).toHaveProperty('pay-order');
  });

  it('pay-order has flags including --order-id and --merchant-trans-id', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('flags');
    const flags = verb.flags as Record<string, unknown>;
    expect(flags).toHaveProperty('order-id');
    expect(flags).toHaveProperty('merchant-trans-id');
    expect(flags).toHaveProperty('idempotency-key');
  });

  it('pay-order has response', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('response');
    const response = verb.response as Record<string, unknown>;
    expect(response).toHaveProperty('pay_status');
    expect(response).toHaveProperty('settlement_path');
  });

  it('pay-order has examples', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('examples');
    const examples = verb.examples as unknown[];
    expect(examples.length).toBeGreaterThanOrEqual(1);
  });

  it('pay-order has error_recovery with PAYMENT_NOT_COMPLETED polling guidance', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('error_recovery');
    const recovery = verb.error_recovery as Record<string, unknown>;
    expect(recovery).toHaveProperty('PAYMENT_NOT_COMPLETED');
    expect(recovery).toHaveProperty('BILLING_MODE_MISMATCH');
    expect(recovery).toHaveProperty('INVALID_ORDER_STATE');
    expect(recovery).toHaveProperty('PAYORDER_FAILED_AFTER_PAYMENT');
  });
});

describe('hotel-redaug schema: book verb removed (Req 10.1, 10.5)', () => {
  it('book verb does NOT exist', () => {
    expect(verbs).not.toHaveProperty('book');
  });

  it('schema does not contain "in one step" combined booking language', () => {
    expect(schemaText.toLowerCase()).not.toContain('in one step');
  });

  it('schema does not contain "create and pay" combined language', () => {
    // The old book description said "Create and pay for a hotel booking in one step"
    expect(schemaText).not.toContain('Create and pay for a hotel booking in one step');
  });

  it('schema does not contain "combined" booking language referencing book', () => {
    // Ensure no "combined payment" or "check + create + pay combined" remains
    expect(schemaText).not.toContain('check + create + pay combined');
    expect(schemaText).not.toContain('combined payment (monthly settlement)');
  });

  it('schema does not contain "do NOT pass --payment-order-id" old guidance', () => {
    expect(schemaText).not.toContain('do NOT pass --payment-order-id');
    expect(schemaText).not.toContain('Do NOT create a payment order and do NOT pass --payment-order-id');
  });

  it('schema does not reference a "payment-order-id" flag', () => {
    expect(schemaText).not.toContain('"payment-order-id"');
  });
});

describe('hotel-redaug schema: workflow describes create-then-pay (Req 7.7, 10.1)', () => {
  it('workflow.steps includes create-order and pay-order verbs in sequence', () => {
    const steps = schema.workflow.steps as Array<{ verb: string }>;
    const verbsInSteps = steps.map((s) => s.verb);
    expect(verbsInSteps).toContain('create-order');
    expect(verbsInSteps).toContain('pay-order');
    // create-order should come before pay-order
    const createIdx = verbsInSteps.indexOf('create-order');
    const payIdx = verbsInSteps.indexOf('pay-order');
    expect(createIdx).toBeLessThan(payIdx);
  });

  it('workflow.steps does not include a "book" step', () => {
    const steps = schema.workflow.steps as Array<{ verb: string }>;
    const verbsInSteps = steps.map((s) => s.verb);
    expect(verbsInSteps).not.toContain('book');
  });

  it('workflow.description mentions create-then-pay two-step flow', () => {
    const desc = schema.workflow.description as string;
    expect(desc).toContain('create-order');
    expect(desc).toContain('pay-order');
  });

  it('workflow follows quote → create-order → pay-order → get sequence', () => {
    const steps = schema.workflow.steps as Array<{ verb: string; next: string | null }>;
    const quoteStep = steps.find((s) => s.verb === 'quote');
    const createStep = steps.find((s) => s.verb === 'create-order');
    const payStep = steps.find((s) => s.verb === 'pay-order');
    expect(quoteStep?.next).toBe('create-order');
    expect(createStep?.next).toBe('pay-order');
    expect(payStep?.next).toBe('get');
  });

  it('prerequisites describe both billing paths', () => {
    const prereqs = schema.workflow.prerequisites as Array<{ when: string; before_verb: string }>;
    expect(prereqs.length).toBeGreaterThanOrEqual(2);
    const monthlyPrereq = prereqs.find((p) => p.when.includes('monthly_settlement'));
    const activePrereq = prereqs.find((p) => p.when.includes('Active_Payment'));
    expect(monthlyPrereq).toBeDefined();
    expect(activePrereq).toBeDefined();
    expect(monthlyPrereq!.before_verb).toBe('pay-order');
    expect(activePrereq!.before_verb).toBe('pay-order');
  });
});

describe('hotel-redaug schema: description and selection_hints (Req 10.1)', () => {
  it('summary describes create-then-pay flow', () => {
    const summary = schema.summary as string;
    expect(summary.toLowerCase()).toContain('create-then-pay');
  });

  it('summary mentions both billing paths', () => {
    const summary = schema.summary as string;
    expect(summary.toLowerCase()).toContain('monthly settlement');
    expect(summary.toLowerCase()).toContain('active payment');
  });

  it('selection_hints.key_features describes two-step booking', () => {
    const features = schema.selection_hints.key_features as string[];
    const twoStepFeature = features.find((f) => f.includes('create-order') && f.includes('pay-order'));
    expect(twoStepFeature).toBeDefined();
  });

  it('conventions.billing_paths documents both settlement paths', () => {
    expect(schema.conventions).toHaveProperty('billing_paths');
    const billingPaths = schema.conventions.billing_paths as string;
    expect(billingPaths).toContain('monthly_settlement');
    expect(billingPaths).toContain('Active_Payment');
    expect(billingPaths).toContain('merchant-trans-id');
  });
});

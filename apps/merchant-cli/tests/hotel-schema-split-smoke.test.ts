/**
 * Schema smoke tests for hotel-redaug create-order + pay-order booking flow.
 *
 * Asserts that the provider schema (hotel-redaug.json) correctly reflects the
 * current architecture: `create-order` settles payment (authorize+capture) AND
 * locks the room with the supplier, then `pay-order` triggers supplier
 * confirmation (upstream payOrder / ticket issuance). There is no combined
 * `book` verb.
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

  it('create-order has flags, including optional payment-method-id', () => {
    const verb = verbs['create-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('flags');
    const flags = verb.flags as Record<string, unknown>;
    expect(Object.keys(flags).length).toBeGreaterThan(0);
    expect(flags).toHaveProperty('payment-method-id');
  });

  it('create-order response includes order_id/fc_order_code/total_amount/currency', () => {
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

  it('create-order has error_recovery with payment-path errors', () => {
    const verb = verbs['create-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('error_recovery');
    const recovery = verb.error_recovery as Record<string, unknown>;
    expect(Object.keys(recovery).length).toBeGreaterThan(0);
    expect(recovery).toHaveProperty('NO_AVAILABILITY');
    expect(recovery).toHaveProperty('PRICE_CHANGED');
    expect(recovery).toHaveProperty('PAYMENT_METHOD_REQUIRED');
  });
});

describe('hotel-redaug schema: pay-order verb triggers supplier confirmation (Req 7.7)', () => {
  it('pay-order verb exists in the schema', () => {
    expect(verbs).toHaveProperty('pay-order');
  });

  it('pay-order has flags including --order-id and --idempotency-key, and no merchant-transaction-id flag', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('flags');
    const flags = verb.flags as Record<string, unknown>;
    expect(flags).toHaveProperty('order-id');
    expect(flags).toHaveProperty('idempotency-key');
    expect(flags).not.toHaveProperty('merchant-trans-id');
  });

  it('pay-order has response with settlement_path', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('response');
    const response = verb.response as Record<string, unknown>;
    expect(response).toHaveProperty('settlement_path');
  });

  it('pay-order has error_recovery', () => {
    const verb = verbs['pay-order'] as Record<string, unknown>;
    expect(verb).toHaveProperty('error_recovery');
    const recovery = verb.error_recovery as Record<string, unknown>;
    expect(recovery).toHaveProperty('INVALID_ORDER_STATE');
  });
});

describe('hotel-redaug schema: book verb removed (Req 10.1, 10.5)', () => {
  it('book verb does NOT exist', () => {
    expect(verbs).not.toHaveProperty('book');
  });

  it('schema does not contain "in one step" combined booking language', () => {
    expect(schemaText.toLowerCase()).not.toContain('in one step');
  });

  it('schema does not reference a "payment-order-id" flag', () => {
    expect(schemaText).not.toContain('"payment-order-id"');
  });
});

describe('hotel-redaug schema: workflow describes create-order → pay-order → get (Req 7.7, 10.1)', () => {
  it('workflow.steps includes create-order and pay-order in sequence', () => {
    const steps = schema.workflow.steps as Array<{ verb: string }>;
    const verbsInSteps = steps.map((s) => s.verb);
    expect(verbsInSteps).toContain('create-order');
    expect(verbsInSteps).toContain('pay-order');
    const createIdx = verbsInSteps.indexOf('create-order');
    const payIdx = verbsInSteps.indexOf('pay-order');
    expect(createIdx).toBeLessThan(payIdx);
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

  it('workflow.description mentions both create-order and pay-order', () => {
    const desc = schema.workflow.description as string;
    expect(desc).toContain('create-order');
    expect(desc).toContain('pay-order');
  });

  it('prerequisites describe both billing paths, gated before create-order', () => {
    const prereqs = schema.workflow.prerequisites as Array<{ when: string; before_verb: string }>;
    expect(prereqs.length).toBeGreaterThanOrEqual(2);
    const monthlyPrereq = prereqs.find((p) => p.when.includes('monthly_settlement'));
    const activePrereq = prereqs.find((p) => p.when.includes('pay_per_call'));
    expect(monthlyPrereq).toBeDefined();
    expect(activePrereq).toBeDefined();
    expect(monthlyPrereq!.before_verb).toBe('create-order');
    expect(activePrereq!.before_verb).toBe('create-order');
  });
});

describe('hotel-redaug schema: description and selection_hints (Req 10.1)', () => {
  it('summary mentions both billing modes', () => {
    const summary = schema.summary as string;
    expect(summary).toContain('monthly_settlement');
    expect(summary).toContain('pay_per_call');
  });

  it('selection_hints.key_features describes create-order + pay-order flow', () => {
    const features = schema.selection_hints.key_features as string[];
    const createFeature = features.find((f) => f.includes('create-order'));
    const payFeature = features.find((f) => f.includes('pay-order'));
    expect(createFeature).toBeDefined();
    expect(payFeature).toBeDefined();
  });

  it('conventions.billing_paths documents both settlement paths', () => {
    expect(schema.conventions).toHaveProperty('billing_paths');
    const billingPaths = schema.conventions.billing_paths as string;
    expect(billingPaths).toContain('monthly_settlement');
    expect(billingPaths).toContain('pay_per_call');
    expect(billingPaths).toContain('pay-order');
  });
});

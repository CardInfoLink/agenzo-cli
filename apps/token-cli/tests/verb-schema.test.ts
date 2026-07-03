import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  wantsJsonSchema,
  emitSchema,
  pmAddSchema,
  pmListSchema,
  pmGetSchema,
  pmDisableSchema,
  ptCreateSchema,
  ptListSchema,
  ptGetSchema,
  ptRevokeSchema,
} from '../src/verb-schema.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// verb-schema `--help --format json` — token domain (mirrors
// apps/merchant-cli/tests/verb-schema.test.ts).
//
// Bug context: before this file existed, token-cli's `--help` always
// rendered commander's default TEXT help regardless of `--format json`.
// The orchestrator's tool discovery could not parse it as JSON, so every
// payment-methods / payment-tokens verb was silently dropped from the LLM's
// tool list — a user typing "bind card" in chat hit an LLM with no
// card-binding tool available.
// ============================================================

describe('wantsJsonSchema (argv detection)', () => {
  it('space form --help --format json → true', () => {
    expect(
      wantsJsonSchema(['node', 'cli', 'payment-methods', 'add', '--help', '--format', 'json']),
    ).toBe(true);
  });

  it('equals form --format=json → true', () => {
    expect(
      wantsJsonSchema(['node', 'cli', 'payment-methods', 'add', '--help', '--format=json']),
    ).toBe(true);
  });

  it('bare --help → false (text help kept)', () => {
    expect(wantsJsonSchema(['node', 'cli', 'payment-methods', 'add', '--help'])).toBe(false);
  });

  it('--help --format table → false', () => {
    expect(
      wantsJsonSchema(['node', 'cli', 'payment-methods', 'add', '--help', '--format', 'table']),
    ).toBe(false);
  });
});

describe('emitSchema', () => {
  it('prints a single pretty JSON object that round-trips with the verb fields', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    emitSchema(pmAddSchema);

    expect(lines).toHaveLength(1);
    const raw = lines[0];
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['cli', 'noun', 'verb', 'description', 'flags', 'response', 'example']) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.cli).toBe('agenzo-token-cli');
    expect(parsed.noun).toBe('payment-methods');
    expect(parsed.verb).toBe('add');
  });
});

describe('verb schema field alignment', () => {
  it('pmAddSchema exposes mode (manual|dropin) and never card/CVV fields (PCI)', () => {
    expect(pmAddSchema.flags.mode.default).toBe('manual');
    // The schema surfaced to the LLM must never mention raw card fields —
    // manual mode collects them CLI-side; dropin mode never touches them.
    expect(pmAddSchema.flags).not.toHaveProperty('card-number');
    expect(pmAddSchema.flags).not.toHaveProperty('cvv');
    expect(pmAddSchema.flags).not.toHaveProperty('expiry');
    expect(pmAddSchema.response).toHaveProperty('session_id');
  });

  it('write verbs (add manual mode is W/N; disable/create/revoke are W/Y) carry idempotency where required', () => {
    expect(pmDisableSchema.flags['idempotency-key'].required).toBe(true);
    expect(ptCreateSchema.flags['idempotency-key'].required).toBe(true);
    expect(ptRevokeSchema.flags['idempotency-key'].required).toBe(true);
  });

  it('all 8 schemas name the token CLI + the correct noun verbatim', () => {
    const pmSchemas = [pmAddSchema, pmListSchema, pmGetSchema, pmDisableSchema];
    const ptSchemas = [ptCreateSchema, ptListSchema, ptGetSchema, ptRevokeSchema];

    for (const s of pmSchemas) {
      expect(s.cli).toBe('agenzo-token-cli');
      expect(s.noun).toBe('payment-methods');
    }
    for (const s of ptSchemas) {
      expect(s.cli).toBe('agenzo-token-cli');
      expect(s.noun).toBe('payment-tokens');
    }
  });

  it('read verbs (list/get) have no idempotency-key flag', () => {
    for (const s of [pmListSchema, pmGetSchema, ptListSchema, ptGetSchema]) {
      expect(s.flags).not.toHaveProperty('idempotency-key');
    }
  });
});

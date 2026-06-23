import { describe, it, expect, vi, afterEach } from 'vitest';
import { CliError, IdempotencyKeyRequiredError, PromptEngine } from '@agenzo/cli-core';
import {
  normalizeIdempotencyKey,
  resolveIdempotencyKey,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_RULE,
} from '../src/idempotency.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// §4.1 normalizeIdempotencyKey — key format validation
// (UT-IDEM-01..09; Property 3 / Req 5.3)
// ============================================================

describe('normalizeIdempotencyKey (idempotency.ts)', () => {
  it('UT-IDEM-01: a legal key is returned verbatim', () => {
    expect(normalizeIdempotencyKey('book-123')).toBe('book-123');
  });

  it('UT-IDEM-02: surrounding whitespace is trimmed', () => {
    expect(normalizeIdempotencyKey('  book-123  ')).toBe('book-123');
  });

  it('UT-IDEM-03: the full [A-Za-z0-9_-] character class is accepted', () => {
    expect(normalizeIdempotencyKey('A_b-9')).toBe('A_b-9');
  });

  it('UT-IDEM-04: an empty string is rejected with PARAM_INVALID (fails {1,128})', () => {
    expect(() => normalizeIdempotencyKey('')).toThrowError(CliError);
    try {
      normalizeIdempotencyKey('');
    } catch (e) {
      expect((e as CliError).code).toBe('PARAM_INVALID');
    }
  });

  it('UT-IDEM-05: an embedded space is rejected with PARAM_INVALID', () => {
    try {
      normalizeIdempotencyKey('has space');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe('PARAM_INVALID');
    }
  });

  it('UT-IDEM-06: out-of-class characters (! @) are rejected with PARAM_INVALID', () => {
    for (const bad of ['bad!char', 'a@b']) {
      try {
        normalizeIdempotencyKey(bad);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).code).toBe('PARAM_INVALID');
      }
    }
  });

  it('UT-IDEM-07: a 129-char key (>128) is rejected with PARAM_INVALID', () => {
    try {
      normalizeIdempotencyKey('a'.repeat(129));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as CliError).code).toBe('PARAM_INVALID');
    }
  });

  it('UT-IDEM-08: a 128-char key (boundary) is accepted', () => {
    const key = 'a'.repeat(128);
    expect(normalizeIdempotencyKey(key)).toBe(key);
  });

  it('UT-IDEM-09: the error message carries the original value + the rule, code PARAM_INVALID', () => {
    let caught: CliError | undefined;
    try {
      normalizeIdempotencyKey('bad!');
    } catch (e) {
      caught = e as CliError;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught!.code).toBe('PARAM_INVALID');
    expect(caught!.message).toContain('bad!');
    expect(caught!.message).toContain(IDEMPOTENCY_KEY_RULE);
    // sanity: the exported rule string matches the documented §6.1 format.
    expect(IDEMPOTENCY_KEY_RULE).toBe('Use 1-128 characters from [A-Za-z0-9_-].');
    expect(IDEMPOTENCY_KEY_PATTERN.test('book-123')).toBe(true);
  });
});

// ============================================================
// §4.2 resolveIdempotencyKey — write-command resolution branches
// (UT-IDEM-10..15; Property 3 / Req 5.3)
// ============================================================

describe('resolveIdempotencyKey (idempotency.ts)', () => {
  it('UT-IDEM-10: a supplied flag is validated + returned regardless of --yes', async () => {
    const spy = vi.spyOn(PromptEngine, 'resolveInput');
    await expect(
      resolveIdempotencyKey('k1', { yes: true, commandPath: 'ride-elife book' }),
    ).resolves.toBe('k1');
    // a supplied flag never prompts.
    expect(spy).not.toHaveBeenCalled();
  });

  it('UT-IDEM-11: a supplied flag is normalized (trimmed) even without --yes', async () => {
    await expect(
      resolveIdempotencyKey('  k1 ', { yes: false, commandPath: 'ride-elife book' }),
    ).resolves.toBe('k1');
  });

  it('UT-IDEM-12: a malformed supplied flag is rejected at the normalize stage (PARAM_INVALID)', async () => {
    await expect(
      resolveIdempotencyKey('bad!', { yes: true, commandPath: 'ride-elife book' }),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
  });

  it('UT-IDEM-13: missing key under --yes throws IdempotencyKeyRequiredError without prompting', async () => {
    const spy = vi.spyOn(PromptEngine, 'resolveInput');
    let caught: CliError | undefined;
    try {
      await resolveIdempotencyKey(undefined, { yes: true, commandPath: 'ride-elife book' });
    } catch (e) {
      caught = e as CliError;
    }
    expect(caught).toBeInstanceOf(IdempotencyKeyRequiredError);
    expect(caught!.code).toBe('PARAM_IDEMPOTENCY_KEY_REQUIRED');
    expect(caught!.message).toContain('ride-elife book');
    expect(caught!.message).toContain('--idempotency-key');
    // hard error: the prompt engine is NEVER consulted under --yes.
    expect(spy).not.toHaveBeenCalled();
  });

  it('UT-IDEM-14: missing key without --yes prompts via PromptEngine and returns the entered key', async () => {
    const spy = vi.spyOn(PromptEngine, 'resolveInput').mockResolvedValue('k2');

    const result = await resolveIdempotencyKey(undefined, {
      yes: false,
      commandPath: 'ride-elife book',
    });
    expect(result).toBe('k2');
    expect(spy).toHaveBeenCalledTimes(1);

    // The prompt config carries the documented message + a validate that
    // rejects illegal input with the rule string.
    const [flagArg, config] = spy.mock.calls[0] as [
      string | undefined,
      { message: string; validate?: (v: string) => boolean | string },
    ];
    expect(flagArg).toBeUndefined();
    expect(config.message).toBe('Idempotency key (unique per write, for safe retry):');
    expect(config.validate!('book-123')).toBe(true);
    expect(config.validate!('bad!')).toBe(IDEMPOTENCY_KEY_RULE);
    expect(config.validate!('   ')).toBe(IDEMPOTENCY_KEY_RULE);
  });

  it('UT-IDEM-15: a prompt that returns an illegal value is caught by the normalize backstop', async () => {
    vi.spyOn(PromptEngine, 'resolveInput').mockResolvedValue('bad!');
    await expect(
      resolveIdempotencyKey(undefined, { yes: false, commandPath: 'ride-elife book' }),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
  });
});

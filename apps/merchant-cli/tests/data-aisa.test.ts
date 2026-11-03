/**
 * Command-level integration tests for the data-aisa verbs (R36 / R37).
 * Mocks ApiClient (no real backend). Verbs are registered on a data-aisa
 * sub-command group, matching the production wiring in index.ts.
 *
 * What these tests pin down, beyond the happy paths:
 *  - `--params` reaches the body as a real OBJECT (never str()-ified anywhere
 *    on the chain), and a non-object / non-JSON value fails locally;
 *  - `--idempotency-key` is OPTIONAL: omitted → no header, request still sent,
 *    no prompt and nothing generated (the orchestrator drives the CLI with
 *    stdin=DEVNULL, so any prompt would be an instant EOF failure);
 *  - `--limit` carries commander's '15' default while `--keyword` carries none.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(), input: vi.fn(), password: vi.fn(), select: vi.fn() }));

import { registerDataListCategoriesCommand } from '../src/data-aisa/list-categories.js';
import { registerDataSearchCommand } from '../src/data-aisa/search.js';
import { registerDataDescribeCommand } from '../src/data-aisa/describe.js';
import { registerDataQueryCommand } from '../src/data-aisa/query.js';
import { buildProgram, captureStdout, parseJsonOutput } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); delete process.env.AGENZO_FORMAT; });

// ── Mock API (substring match on path, separate get/post spies) ───────────
function dataApi(responses: Record<string, unknown> = {}) {
  const impl = (path: string) => {
    for (const [key, data] of Object.entries(responses)) {
      if (path.includes(key)) return Promise.resolve({ success: true, data });
    }
    return Promise.resolve({ success: true, data: {} });
  };
  return { get: vi.fn().mockImplementation(impl), post: vi.fn().mockImplementation(impl) };
}
type Deps = { apiClient: ApiClient };

// ── Fixtures (shapes per the pinned response contract) ────────────────────
const CATEGORIES = { categories: [{ category: 'SEO & Search Data', endpoints: 466 }] };
const SEARCH = {
  results: [{
    operationId: 'get_coingecko_simple_price', method: 'GET', path: '/coingecko/simple/price',
    tags: ['Crypto Data'], summary: 'Simple Price', price_usd: 0.008,
  }],
};
const DESCRIBE = {
  operationId: 'get_coingecko_simple_price', method: 'GET', path: '/coingecko/simple/price',
  params: [{ name: 'ids', in: 'query', required: true, type: 'string', desc: '' }],
  required: ['ids'], usage: 'Required: ids.', price_usd: 0.008, tags: ['Crypto Data'], cost_tier: 'low',
};
const QUERY = { data: { bitcoin: { usd: 64000 } }, cost_usd: 0.008 };

// ── Helper: data-aisa subcommand group (mirrors index.ts) ─────────────────
function setup(
  register: (parent: any, deps: Deps) => void,
  responses: Record<string, unknown> = {},
) {
  const api = dataApi(responses);
  const prog = buildProgram();
  const dataCmd = prog.command('data-aisa');
  register(dataCmd, { apiClient: api as unknown as ApiClient });
  return { prog, get: api.get as unknown as Mock, post: api.post as unknown as Mock };
}

// ── 1. registration: the noun carries exactly the four verbs ──────────────

describe('data-aisa: command group registration', () => {
  it('registers exactly the four verbs on the noun', () => {
    const api = dataApi();
    const prog = buildProgram();
    const dataCmd = prog.command('data-aisa');
    const deps = { apiClient: api as unknown as ApiClient };
    registerDataListCategoriesCommand(dataCmd, deps);
    registerDataSearchCommand(dataCmd, deps);
    registerDataDescribeCommand(dataCmd, deps);
    registerDataQueryCommand(dataCmd, deps);

    expect(dataCmd.commands.map((c) => c.name()).sort()).toEqual(
      ['describe', 'list-categories', 'query', 'search'],
    );
  });

  it('all four verbs parse and run without throwing', async () => {
    const api = dataApi({
      '/data/categories': CATEGORIES,
      '/data/search': SEARCH,
      '/data/describe/': DESCRIBE,
      '/data/query': QUERY,
    });
    const prog = buildProgram();
    const dataCmd = prog.command('data-aisa');
    const deps = { apiClient: api as unknown as ApiClient };
    registerDataListCategoriesCommand(dataCmd, deps);
    registerDataSearchCommand(dataCmd, deps);
    registerDataDescribeCommand(dataCmd, deps);
    registerDataQueryCommand(dataCmd, deps);

    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'data-aisa', 'list-categories', '--api-key', 'k', '--format', 'json']);
    await prog.parseAsync(['node', 'test', 'data-aisa', 'search', '--api-key', 'k', '--format', 'json']);
    await prog.parseAsync(['node', 'test', 'data-aisa', 'describe', '--api-key', 'k', '--format', 'json', '--operation-id', 'get_coingecko_simple_price']);
    await prog.parseAsync(['node', 'test', 'data-aisa', 'query', '--api-key', 'k', '--format', 'json', '--operation-id', 'get_coingecko_simple_price']);
    out.spy.mockRestore();

    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

// ── 2. list-categories ────────────────────────────────────────────────────

describe('data-aisa: list-categories', () => {
  it('GETs /data/categories and renders the categories', async () => {
    const { prog, get } = setup(registerDataListCategoriesCommand, { '/data/categories': CATEGORIES });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'data-aisa', 'list-categories', '--api-key', 'k', '--format', 'json']);
    out.spy.mockRestore();

    const [path, auth] = get.mock.calls[0] as [string, unknown];
    expect(path).toBe('/data/categories');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    const p = parseJsonOutput(out.text()) as any;
    expect(p.categories[0].category).toBe('SEO & Search Data');
  });
});

// ── 3. search: query params + the pinned '15' default (N3) ────────────────

describe('data-aisa: search', () => {
  it('stringifies --keyword / --limit into the query params', async () => {
    const { prog, get } = setup(registerDataSearchCommand, { '/data/search': SEARCH });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'data-aisa', 'search', '--api-key', 'k', '--format', 'json', '--keyword', 'x', '--limit', '3']);
    out.spy.mockRestore();

    expect(get).toHaveBeenCalledWith('/data/search', { type: 'api-key', key: 'k' }, { keyword: 'x', limit: '3' });
    const p = parseJsonOutput(out.text()) as any;
    expect(p.results[0].operationId).toBe('get_coingecko_simple_price');
  });

  it("omits keyword entirely when not given, and sends commander's '15' limit default", async () => {
    const { prog, get } = setup(registerDataSearchCommand, { '/data/search': SEARCH });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'data-aisa', 'search', '--api-key', 'k', '--format', 'json']);
    out.spy.mockRestore();

    const params = (get.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(params).not.toHaveProperty('keyword');
    expect(params.limit).toBe('15');
  });

  it('a non-numeric --limit is rejected locally with PARAM_INVALID', async () => {
    const { prog, get } = setup(registerDataSearchCommand, { '/data/search': SEARCH });
    await expect(
      prog.parseAsync(['node', 'test', 'data-aisa', 'search', '--api-key', 'k', '--format', 'json', '--limit', 'many']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(get).not.toHaveBeenCalled();
  });
});

// ── 4. describe: path param + required flag ───────────────────────────────

describe('data-aisa: describe', () => {
  it('GETs /data/describe/{operation_id}', async () => {
    const { prog, get } = setup(registerDataDescribeCommand, { '/data/describe/': DESCRIBE });
    const out = captureStdout();
    await prog.parseAsync(['node', 'test', 'data-aisa', 'describe', '--api-key', 'k', '--format', 'json', '--operation-id', 'get_x']);
    out.spy.mockRestore();

    const [path, auth] = get.mock.calls[0] as [string, unknown];
    expect(path).toBe('/data/describe/get_x');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    const p = parseJsonOutput(out.text()) as any;
    expect(p.price_usd).toBe(0.008);
  });

  it('missing --operation-id → PARAM_INVALID before any request', async () => {
    const { prog, get } = setup(registerDataDescribeCommand, { '/data/describe/': DESCRIBE });
    await expect(
      prog.parseAsync(['node', 'test', 'data-aisa', 'describe', '--api-key', 'k', '--format', 'json']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(get).not.toHaveBeenCalled();
  });
});

// ── 5. query: object params, optional idempotency key ─────────────────────

describe('data-aisa: query', () => {
  const args = (extra: string[]) => [
    'node', 'test', 'data-aisa', 'query', '--api-key', 'k', '--format', 'json',
    '--operation-id', 'get_coingecko_simple_price', ...extra,
  ];

  it('POSTs /data/query with operation_id and renders data + cost_usd', async () => {
    const { prog, post } = setup(registerDataQueryCommand, { '/data/query': QUERY });
    const out = captureStdout();
    await prog.parseAsync(args([]));
    out.spy.mockRestore();

    const [path, auth, body] = post.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(path).toBe('/data/query');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body).toEqual({ operation_id: 'get_coingecko_simple_price' });
    const p = parseJsonOutput(out.text()) as any;
    expect(p.cost_usd).toBe(0.008);
  });

  it('--params reaches the body as an OBJECT, verbatim (never str()-ified)', async () => {
    const { prog, post } = setup(registerDataQueryCommand, { '/data/query': QUERY });
    const out = captureStdout();
    await prog.parseAsync(args(['--params', '{"a":1}']));
    out.spy.mockRestore();

    const body = (post.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(body.params).toEqual({ a: 1 });
    expect(typeof body.params).toBe('object');
  });

  it.each([
    ['a JSON array', '[1,2]'],
    ['a non-JSON string', 'oops'],
  ])('--params %s → PARAM_INVALID before any request', async (_label, raw) => {
    const { prog, post } = setup(registerDataQueryCommand, { '/data/query': QUERY });
    await expect(prog.parseAsync(args(['--params', raw]))).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(post).not.toHaveBeenCalled();
  });

  // R36: the key is validated AS GIVEN and forwarded verbatim — surrounding
  // whitespace is malformed input, not something the CLI silently trims away.
  it.each([
    ['illegal characters', 'bad key!'],
    ['leading/trailing whitespace', ' k-1 '],
    ['a trailing newline', 'k-1\n'],
    ['an empty value', ''],
  ])('a malformed --idempotency-key (%s) → PARAM_INVALID before any request', async (_label, raw) => {
    const { prog, post } = setup(registerDataQueryCommand, { '/data/query': QUERY });
    await expect(
      prog.parseAsync(args(['--idempotency-key', raw])),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(post).not.toHaveBeenCalled();
  });

  it('a valid --idempotency-key is forwarded as the header only, never in the body', async () => {
    const { prog, post } = setup(registerDataQueryCommand, { '/data/query': QUERY });
    const out = captureStdout();
    await prog.parseAsync(args(['--idempotency-key', 'k-1']));
    out.spy.mockRestore();

    const [, , body, headers] = post.mock.calls[0] as [string, unknown, Record<string, unknown>, unknown];
    expect(headers).toEqual({ 'Idempotency-Key': 'k-1' });
    expect(body).not.toHaveProperty('idempotency_key');
    expect(JSON.stringify(body)).not.toContain('k-1');
  });

  // R37: the non-interactive contract. No key → no header, request still sent,
  // nothing prompted and nothing generated.
  it('omitting --idempotency-key sends no header and still issues the request', async () => {
    const { prog, post } = setup(registerDataQueryCommand, { '/data/query': QUERY });
    const out = captureStdout();
    await prog.parseAsync(args([]));
    out.spy.mockRestore();

    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as unknown[])[3]).toBeUndefined();
  });
});

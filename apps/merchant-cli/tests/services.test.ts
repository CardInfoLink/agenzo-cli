import { describe, it, expect, vi, afterEach } from 'vitest';
import { CliError } from '@agenzo/cli-core';
import { registerServicesListCommand } from '../src/services/list.js';
import { registerServiceGetCommand } from '../src/services/get.js';
import { SERVICE_REGISTRY, findService } from '../src/services/registry.js';
import { buildProgram, captureStdout, captureStderr, parseJsonOutput } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

// ============================================================
// services registry (unit) — §4.7 UT-REG-01..03 (Req 1.1, 1.2)
// ============================================================

describe('services registry (registry.ts)', () => {
  it('UT-REG-01: findService("ride-elife") returns the full capability', () => {
    const svc = findService('ride-elife');
    expect(svc).toBeDefined();
    expect(svc!.service_id).toBe('ride-elife');
    expect(svc!.category).toBe('ride');
    expect(svc!.provider).toBe('elife');
    expect(svc!.cli_noun).toBe('ride-elife');
    expect(svc!.verbs).toHaveLength(5);
    expect(svc!.workflow.length).toBeGreaterThan(0);
    expect(svc!.since).toBeTruthy();
    expect(svc!.discovery.help_command).toContain('ride-elife');
  });

  it('UT-REG-02: findService("nope") returns undefined', () => {
    expect(findService('nope')).toBeUndefined();
  });

  it('UT-REG-03: first registry entry exposes the 5 ride verbs in order', () => {
    expect(SERVICE_REGISTRY[0].verbs).toEqual(['quote', 'book', 'get', 'cancel', 'list-orders']);
  });
});

// ============================================================
// services list — §5.1 TC-SVC-LST-01..06 (Req 1.1, 1.3, 5.1)
// ============================================================

describe('services list', () => {
  it('TC-SVC-LST-01/02: lists registry entries with discovery fields, no HTTP call', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServicesListCommand(cmd);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json']);

    const payload = parseJsonOutput(out.text()) as { services: Array<Record<string, unknown>> };
    expect(Array.isArray(payload.services)).toBe(true);
    expect(payload.services.length).toBe(SERVICE_REGISTRY.length);

    const item = payload.services[0];
    // §4.4.1.1 list item shape — discovery-relevant subset.
    for (const key of [
      'service_id', 'name', 'category', 'provider', 'cli_noun', 'version', 'verbs', 'since', 'discovery',
    ]) {
      expect(item).toHaveProperty(key);
    }
    expect(item.service_id).toBe('ride-elife');
    expect(item.verbs).toEqual(['quote', 'book', 'get', 'cancel', 'list-orders']);
  });

  it('TC-SVC-LST-06: list items omit the heavy verb_descriptions / workflow detail', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServicesListCommand(cmd);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json']);

    const payload = parseJsonOutput(out.text()) as { services: Array<Record<string, unknown>> };
    const item = payload.services[0];
    expect(item).not.toHaveProperty('verb_descriptions');
    expect(item).not.toHaveProperty('workflow');
    expect(item).not.toHaveProperty('description');
  });

  it('TC-SVC-LST-04: json stdout is a single valid JSON with services + profile/endpoint envelope, stderr silent', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServicesListCommand(cmd);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'json']);

    // stdout parses as a single JSON object (pure payload).
    const payload = parseJsonOutput(out.text()) as Record<string, unknown>;
    expect(payload).toHaveProperty('services');
    // renderWithContext envelope (BACK-011): profile + endpoint (host only).
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');
    expect(typeof payload.profile).toBe('string');
    expect(typeof payload.endpoint).toBe('string');
    expect(String(payload.endpoint)).not.toContain('/api/');

    // json mode keeps stderr completely silent (no status icons / chrome).
    const stderrText = err.text();
    expect(stderrText).toBe('');
    expect(stderrText).not.toMatch(/[✓ℹ⚠✗]/);
  });

  it('TC-SVC-LST-05: table output renders headers and the ride-elife row', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServicesListCommand(cmd);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'list', '--format', 'table']);

    const output = out.text();
    for (const header of ['Service ID', 'Name', 'Category', 'Provider', 'Version', 'Verbs']) {
      expect(output).toContain(header);
    }
    expect(output).toContain('ride-elife');
  });
});

// ============================================================
// services get — §5.2 TC-SVC-GET-01/04/05 hit + TC-SVC-GET-02 miss
// (Req 1.2, 1.3, 5.1)
// ============================================================

describe('services get', () => {
  it('TC-SVC-GET-01/05: hit returns full capability with verb_descriptions/workflow + json envelope, stderr silent', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServiceGetCommand(cmd);

    const out = captureStdout();
    const err = captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'get', 'ride-elife', '--format', 'json']);

    const payload = parseJsonOutput(out.text()) as Record<string, unknown>;
    expect(payload.service_id).toBe('ride-elife');
    // Full metadata (not the list subset).
    expect(payload).toHaveProperty('verb_descriptions');
    expect(payload).toHaveProperty('workflow');
    expect(payload).toHaveProperty('discovery');
    // profile/endpoint envelope.
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');

    expect(err.text()).toBe('');
  });

  it('TC-SVC-GET-04: table output renders the full key/value block including verb descriptions', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServiceGetCommand(cmd);

    const out = captureStdout();
    captureStderr();

    await program.parseAsync(['node', 'cli', 'services', 'get', 'ride-elife', '--format', 'table']);

    const output = out.text();
    expect(output).toContain('ride-elife');
    expect(output).toContain('Workflow');
    expect(output).toContain('Verb descriptions:');
  });

  it('TC-SVC-GET-02: miss throws CliError(SERVICE_NOT_FOUND) and points to "services list"', async () => {
    const program = buildProgram();
    const cmd = program.command('services');
    registerServiceGetCommand(cmd);

    const out = captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(['node', 'cli', 'services', 'get', 'nope', '--format', 'json']),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });

    // Re-run to assert message + error type without consuming the rejection above.
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'cli', 'services', 'get', 'nope', '--format', 'json']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain('services list');

    // Failure path must not emit any business payload on stdout.
    expect(out.text()).toBe('');
  });
});

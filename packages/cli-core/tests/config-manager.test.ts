import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, resolveApiHost } from '../config/config-manager.js';

describe('resolveApiHost', () => {
  it('resolves built-in profiles and HTTPS hosts', () => {
    expect(resolveApiHost('production')).toBe('https://agent.everonet.com');
    expect(resolveApiHost('testing')).toBe('https://agent-test.everonet.com');
    expect(resolveApiHost('https://example.com')).toBe('https://example.com');
  });

  it('allows HTTP only for localhost and 127.0.0.1', () => {
    expect(resolveApiHost('http://localhost:8000')).toBe('http://localhost:8000');
    expect(resolveApiHost('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
  });

  it('rejects insecure non-local HTTP hosts and malformed URLs', () => {
    expect(() => resolveApiHost('http://example.com')).toThrow('Insecure API host');
    expect(() => resolveApiHost('http://agent.everonet.com')).toThrow('Insecure API host');
    expect(() => resolveApiHost('agent.everonet.com')).toThrow('Unknown profile or invalid URL');
  });
});

describe('ConfigManager host enforcement', () => {
  it('rejects an existing non-local HTTP host when building request URLs', async () => {
    const basePath = await mkdtemp(join(tmpdir(), 'agenzo-config-'));
    try {
      await writeFile(
        join(basePath, 'config.json'),
        JSON.stringify({
          active_org: null,
          active_developer_id: null,
          api_host: 'http://example.com',
          api_path: '/api/admin/v1',
        }),
      );

      const manager = new ConfigManager(basePath);
      await expect(manager.getApiBaseUrl()).rejects.toThrow('Insecure API host');
      await expect(manager.getApiHost()).rejects.toThrow('Insecure API host');
    } finally {
      await rm(basePath, { recursive: true, force: true });
    }
  });
});

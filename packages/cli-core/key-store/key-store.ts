import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { StoredApiKey } from '../types/config.js';

export class KeyStore {
  private readonly basePath: string;

  constructor(basePath?: string) {
    // API keys are shared across runtime-plane CLIs (token/merchant/payment).
    // Stored under the legacy path for backward compatibility; will migrate to
    // ~/.agenzo/keys/ in a future release.
    this.basePath = basePath ?? join(homedir(), '.agenzo-token-cli', 'api-keys');
  }

  private filePath(orgId: string): string {
    return join(this.basePath, `${orgId}.json`);
  }

  private async loadData(orgId: string): Promise<StoredApiKey[]> {
    try {
      const content = await readFile(this.filePath(orgId), 'utf-8');
      return JSON.parse(content) as StoredApiKey[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async saveData(orgId: string, data: StoredApiKey[]): Promise<void> {
    // Stored API keys are plaintext secrets — dir 0700, file 0600.
    await mkdir(this.basePath, { recursive: true, mode: 0o700 });
    await chmod(this.basePath, 0o700);
    const path = this.filePath(orgId);
    await writeFile(path, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(path, 0o600);
  }

  async add(orgId: string, key: StoredApiKey): Promise<void> {
    const data = await this.loadData(orgId);
    data.push(key);
    await this.saveData(orgId, data);
  }

  async update(orgId: string, keyId: string, newKeyValue: string): Promise<void> {
    const data = await this.loadData(orgId);
    const key = data.find((k) => k.key_id === keyId);
    if (key) {
      key.key_value = newKeyValue;
      await this.saveData(orgId, data);
    }
  }

  async list(orgId: string): Promise<StoredApiKey[]> {
    return this.loadData(orgId);
  }

  async get(orgId: string, keyId: string): Promise<StoredApiKey | null> {
    const data = await this.loadData(orgId);
    return data.find((k) => k.key_id === keyId) ?? null;
  }
}

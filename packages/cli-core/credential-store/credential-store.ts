import { readFile, writeFile, readdir, unlink, access, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { OrgCredential } from '../types/config.js';

export class CredentialStore {
  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(homedir(), '.agenzo-admin-cli', 'credentials');
  }

  private filePath(orgId: string): string {
    return join(this.basePath, `${orgId}.json`);
  }

  private async ensureDir(): Promise<void> {
    // Credentials hold long-lived Bearer tokens — dir must be owner-only (0700).
    // mkdir mode is subject to umask, so chmod afterwards to enforce it on
    // both freshly created and pre-existing directories.
    await mkdir(this.basePath, { recursive: true, mode: 0o700 });
    await chmod(this.basePath, 0o700);
  }

  async get(orgId: string): Promise<OrgCredential | null> {
    try {
      const content = await readFile(this.filePath(orgId), 'utf-8');
      return JSON.parse(content) as OrgCredential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(credential: OrgCredential): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(credential.org_id);
    // Owner read/write only (0600); chmod after write so pre-existing files
    // created before this safeguard also get tightened.
    await writeFile(path, JSON.stringify(credential, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(path, 0o600);
  }

  async delete(orgId: string): Promise<void> {
    try {
      await unlink(this.filePath(orgId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async listAll(): Promise<OrgCredential[]> {
    try {
      const files = await readdir(this.basePath);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      const credentials: OrgCredential[] = [];
      for (const file of jsonFiles) {
        try {
          const content = await readFile(join(this.basePath, file), 'utf-8');
          credentials.push(JSON.parse(content) as OrgCredential);
        } catch {
          // Skip corrupted files
        }
      }
      return credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async exists(orgId: string): Promise<boolean> {
    try {
      await access(this.filePath(orgId));
      return true;
    } catch {
      return false;
    }
  }
}

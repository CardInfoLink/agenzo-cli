import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AppConfig } from '../types/config.js';
import { ConfigError, ValidationError } from '../errors/errors.js';

// §6 target routing: each product line is served under its own prefix
// (/api/{line}/v1). The prefix is a per-binary constant injected into
// ConfigManager (see constructor `apiPath`), NOT a single shared value — the
// four CLIs hit different product lines under one shared api_host.
// This default is the admin control-plane prefix; other CLIs override it.
const DEFAULT_API_PATH = '/api/admin/v1';

const DEFAULT_CONFIG: AppConfig = {
  active_org: null,
  active_developer_id: null,
  api_host: 'https://agent.everonet.com',
  api_path: DEFAULT_API_PATH,
};

export const BUILTIN_PROFILES: Record<string, string> = {
  production: 'https://agent.everonet.com',
  testing: 'https://agent-test.everonet.com',
};

/**
 * Resolve a user-supplied host argument (a built-in profile name or an
 * explicit URL) to the concrete API host URL that gets persisted.
 * Pure (no I/O) so callers can compute the resolved value before/without a
 * config write — e.g. `config set-host` needs it to match stored credentials
 * by their resolved `api_host` rather than the raw profile name.
 * Throws `ValidationError` for unknown profiles / malformed URLs.
 */
export function resolveApiHost(host: string): string {
  if (BUILTIN_PROFILES[host]) {
    return BUILTIN_PROFILES[host];
  }

  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new ValidationError(`Unknown profile or invalid URL: ${host}`);
  }

  if (url.protocol === 'https:') {
    return host;
  }

  if (
    url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    return host;
  }

  // Allow HTTP for Docker internal container-to-container traffic (gated by env var)
  if (url.protocol === 'http:' && process.env.AGENZO_ALLOW_INSECURE_HOST === '1') {
    return host;
  }

  throw new ValidationError(
    `Insecure API host is not allowed: ${host}. Use HTTPS, except for localhost or 127.0.0.1.`,
  );
}

export class ConfigManager {
  private readonly basePath: string;
  private readonly configPath: string;
  /**
   * Product-line API prefix this CLI targets (e.g. /api/admin/v1,
   * /api/token/v1). Injected per binary so the four CLIs share one api_host
   * but route to different product lines. Overrides any persisted api_path.
   */
  private readonly apiPath: string;

  constructor(basePath?: string, apiPath?: string) {
    this.basePath = basePath ?? join(homedir(), '.agenzo-admin-cli');
    this.configPath = join(this.basePath, 'config.json');
    this.apiPath = apiPath ?? DEFAULT_API_PATH;
  }

  /** The resolved product-line API prefix for this CLI (per-binary constant). */
  getApiPath(): string {
    return this.apiPath;
  }

  async ensureDirectories(): Promise<void> {
    // Base dir contains the credentials/ subtree → owner-only (0700).
    await mkdir(this.basePath, { recursive: true, mode: 0o700 });
    await chmod(this.basePath, 0o700);
    const credDir = join(this.basePath, 'credentials');
    await mkdir(credDir, { recursive: true, mode: 0o700 });
    await chmod(credDir, 0o700);
  }

  async load(): Promise<AppConfig> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      try {
        const raw = JSON.parse(content) as Record<string, unknown>;
        // Migrate old api_base_url format
        if (raw.api_base_url && !raw.api_host) {
          const url = String(raw.api_base_url);
          const pathIndex = url.indexOf('/api/');
          raw.api_host = pathIndex > 0 ? url.slice(0, pathIndex) : url;
          raw.api_path = pathIndex > 0 ? url.slice(pathIndex) : DEFAULT_CONFIG.api_path;
          delete raw.api_base_url;
        }
        return {
          active_org: (raw.active_org as string) ?? null,
          active_developer_id: (raw.active_developer_id as string) ?? null,
          api_host: (raw.api_host as string) ?? DEFAULT_CONFIG.api_host,
          api_path: (raw.api_path as string) ?? DEFAULT_CONFIG.api_path,
        };
      } catch {
        throw new ConfigError(
          `Invalid config file: ${this.configPath}`,
          this.configPath,
        );
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...DEFAULT_CONFIG };
      }
      throw error;
    }
  }

  async save(config: AppConfig): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(this.configPath, 0o600);
  }

  async getActiveOrg(): Promise<string | null> {
    const config = await this.load();
    return config.active_org;
  }

  async setActiveOrg(orgId: string): Promise<void> {
    const config = await this.load();
    config.active_org = orgId;
    await this.save(config);
  }

  async getApiBaseUrl(): Promise<string> {
    const config = await this.load();
    const host = resolveApiHost(config.api_host).replace(/\/+$/, '');
    // Use the per-binary product-line prefix, not the persisted api_path —
    // the latter is shared across all CLIs and would route every binary to the
    // same product line. The injected prefix overrides any stale stored value.
    const path = this.apiPath.startsWith('/') ? this.apiPath : `/${this.apiPath}`;
    return `${host}${path}`;
  }

  async setApiHost(host: string): Promise<void> {
    const config = await this.load();
    config.api_host = resolveApiHost(host);
    await this.save(config);
  }

  async getApiHost(): Promise<string> {
    const config = await this.load();
    return resolveApiHost(config.api_host);
  }
}

import { renderWithContext } from '@agenzo/cli-core';
import { ApiClient, ApiResult, AuthMode } from '@agenzo/cli-core';
import { CredentialStore } from '@agenzo/cli-core';
import { ConfigManager } from '@agenzo/cli-core';
import { OrgCredential } from '@agenzo/cli-core';
import type {
  MagicLinkStatusResponse,
  RefreshResponse,
} from '../types/api.js';
import { AuthError } from '@agenzo/cli-core';
import { PromptEngine } from '@agenzo/cli-core';
import { createSpinner, Spinner } from '@agenzo/cli-core';

export interface LoginResult {
  credential: OrgCredential;
  isNewRegistration: boolean;
}

export interface LoginOptions {
  /**
   * Value supplied via `--idempotency-key`, forwarded verbatim as the
   * `Idempotency-Key` header on `POST /auth/login` (and `/auth/register` for
   * new registrations). Never auto-generated.
   */
  idempotencyKey?: string;
  /**
   * Suppress human-facing status lines (e.g. "Magic link sent") on stderr.
   * Set in `--format json` mode so agent consumers get clean output — only
   * interactive prompts (org name / invitation code) and errors remain.
   */
  quiet?: boolean;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_REFRESH_THRESHOLD_S = 300; // 5 minutes

export class AuthService {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly credentialStore: CredentialStore,
    private readonly configManager: ConfigManager,
  ) {}

  async login(email: string, options: LoginOptions = {}): Promise<LoginResult> {
    const { Formatter } = await import('@agenzo/cli-core');
    let isNewRegistration = false;
    const noAuth: AuthMode = { type: 'none' };

    // Forward `--idempotency-key` verbatim as the Idempotency-Key header on the
    // server writes (login / register). Omitted entirely when not supplied —
    // never auto-generated (Requirement 4.3).
    const idempotencyHeaders = options.idempotencyKey
      ? { 'Idempotency-Key': options.idempotencyKey }
      : undefined;

    // Step 1: Probe whether this email is already registered.
    // No user-facing status here — we haven't sent anything yet, and we may
    // still need to collect organization / invitation details.
    const loginResult = await this.apiClient.post<{ magic_link_token: string }>(
      '/auth/login',
      noAuth,
      { email },
      idempotencyHeaders,
    );

    let magicLinkToken: string;

    if (!loginResult.success && loginResult.errorCode === 1007) {
      // Email not registered — collect org name (and optionally invitation code) and register
      isNewRegistration = true;
      const orgName = await PromptEngine.resolveInput(undefined, {
        message: 'Organization name:',
      });

      const registerBody: Record<string, string> = {
        email,
        organization_name: orgName,
      };

      // Attempt registration; if backend requires an invitation code (1103),
      // prompt for it and retry. Still silent — the email isn't sent until
      // we have all required fields.
      let registerResult = await this.apiClient.post<{ magic_link_token: string }>(
        '/auth/register',
        noAuth,
        registerBody,
        idempotencyHeaders,
      );

      if (!registerResult.success && registerResult.errorCode === 1103) {
        const invitationCode = await PromptEngine.resolveInput(undefined, {
          message: 'Invitation code:',
        });
        registerBody.invitation_code = invitationCode;
        registerResult = await this.apiClient.post<{ magic_link_token: string }>(
          '/auth/register',
          noAuth,
          registerBody,
          idempotencyHeaders,
        );
      }

      if (!registerResult.success) {
        throw new AuthError(
          `Registration failed: ${registerResult.errorMessage}`,
          'Please check your input and try again',
        );
      }
      magicLinkToken = registerResult.data.magic_link_token;
    } else if (!loginResult.success) {
      throw new AuthError(
        `Login failed: ${loginResult.errorMessage}`,
        'Please check your email and try again',
      );
    } else {
      magicLinkToken = loginResult.data.magic_link_token;
    }

    // Magic link token in hand means the backend has dispatched the email.
    // This is the only place the "Sending magic link" status is truthful.
    // Status/progress lines are logs — stderr only, and suppressed in quiet
    // (json) mode so agent consumers get clean output (Requirement 4.4).
    if (!options.quiet) {
      console.error(Formatter.status('success', 'Magic link sent. Please check your inbox.'));
    }

    // Step 2: Poll magic link status
    const credential = await this.pollMagicLinkStatus(
      magicLinkToken,
      email,
      options.quiet,
    );

    // Step 3: Save credential and update active org
    await this.credentialStore.save(credential);
    await this.configManager.setActiveOrg(credential.org_id);

    return { credential, isNewRegistration };
  }

  private async pollMagicLinkStatus(
    magicLinkToken: string,
    email: string,
    quiet = false,
  ): Promise<OrgCredential> {
    const startTime = Date.now();
    const noAuth: AuthMode = { type: 'none' };
    // The spinner draws to stdout; in quiet (json) mode skip it entirely so
    // the stdout payload stays clean for agent consumers.
    const spinner: Spinner | null = quiet
      ? null
      : createSpinner('Waiting for email verification');

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      const result = await this.apiClient.get<MagicLinkStatusResponse>(
        '/auth/magic-links/status',
        noAuth,
        { token: magicLinkToken },
      );

      if (!result.success) {
        spinner?.stop();
        if (result.errorCode === 1101) {
          throw new AuthError('Magic link expired', 'Please run agenzo-admin-cli auth login again');
        }
        throw new AuthError(
          `Polling failed: [${result.errorCode}] ${result.errorMessage}`,
          'Please run agenzo-admin-cli auth login again',
        );
      }

      const data = result.data;

      if (data.status === 'CONSUMED') {
        spinner?.stop();
        const raw = data as unknown as Record<string, unknown>;
        const org = raw.organization as Record<string, unknown> | undefined;

        const orgId = String(raw.organization_id ?? org?.id ?? '');
        const orgName = String(org?.name ?? '');

        // Handle expires_at: could be ISO string or unix timestamp
        let accessExpiresAt: number;
        const rawExpires = raw.expires_at ?? data.access_token_expires_at;
        if (typeof rawExpires === 'string') {
          accessExpiresAt = Math.floor(new Date(rawExpires).getTime() / 1000);
        } else {
          accessExpiresAt = (rawExpires as number) ?? 0;
        }

        const refreshExpiresAt = data.refresh_token_expires_at
          ?? accessExpiresAt + 30 * 24 * 60 * 60;

        return {
          org_id: orgId,
          org_name: orgName,
          email,
          access_token: data.access_token!,
          refresh_token: data.refresh_token!,
          access_token_expires_at: accessExpiresAt,
          refresh_token_expires_at: refreshExpiresAt,
          api_host: (await this.configManager.getApiHost()),
        };
      }

      if (data.status === 'EXPIRED') {
        spinner?.stop();
        throw new AuthError('Magic link expired', 'Please run agenzo-admin-cli auth login again');
      }

      await this.sleep(POLL_INTERVAL_MS);
    }

    spinner?.stop();
    throw new AuthError('Login timed out (10 minutes)', 'Please run agenzo-admin-cli auth login again');
  }

  async logout(): Promise<void> {
    const orgId = await this.configManager.getActiveOrg();
    if (!orgId) {
      throw new AuthError('Not signed in', 'Please run agenzo-admin-cli auth login first');
    }

    const credential = await this.credentialStore.get(orgId);
    if (credential) {
      // Best-effort server logout
      try {
        await this.apiClient.post(
          '/auth/logout',
          { type: 'bearer', token: credential.access_token },
        );
      } catch {
        // Ignore network errors during logout
      }
    }

    await this.credentialStore.delete(orgId);
  }

  async getValidAccessToken(): Promise<string> {
    const orgId = await this.configManager.getActiveOrg();
    if (!orgId) {
      throw new AuthError('Not signed in', 'Please run agenzo-admin-cli auth login first');
    }

    const credential = await this.credentialStore.get(orgId);
    if (!credential) {
      throw new AuthError('Not signed in', 'Please run agenzo-admin-cli auth login first');
    }

    const now = Math.floor(Date.now() / 1000);
    if (credential.access_token_expires_at - now < TOKEN_REFRESH_THRESHOLD_S) {
      try {
        await this.refreshToken(orgId);
        const refreshed = await this.credentialStore.get(orgId);
        return refreshed!.access_token;
      } catch {
        // Refresh failed (token expired, revoked, etc.) — auto re-login
        return this.autoReLogin(credential);
      }
    }

    return credential.access_token;
  }

  /**
   * Automatically re-login using the stored email.
   * Sends a magic link and polls until verified, then updates the
   * credential without changing the active org.
   */
  private async autoReLogin(credential: OrgCredential): Promise<string> {
    const { Formatter } = await import('@agenzo/cli-core');
    const { resolveFormat } = await import('@agenzo/cli-core');
    // Auto re-login is triggered from deep inside executeWithAuth and has no
    // direct format context, so read the resolved format from the environment
    // (index.ts mirrors the global --format into AGENZO_FORMAT after parsing).
    // Status lines must go to stderr (never stdout — that would corrupt the
    // JSON payload), and stay silent entirely in json mode for agent consumers.
    const quiet = resolveFormat(undefined) === 'json';
    if (!quiet) {
      console.error(Formatter.status('info', 'Session expired, re-authenticating'));
      console.error(Formatter.status('loading', 'Sending magic link'));
    }

    const noAuth: AuthMode = { type: 'none' };
    const loginResult = await this.apiClient.post<{ magic_link_token: string }>(
      '/auth/login',
      noAuth,
      { email: credential.email },
    );

    if (!loginResult.success) {
      throw new AuthError(
        `Auto re-login failed: ${loginResult.errorMessage}`,
        'Please run agenzo-admin-cli auth login manually',
      );
    }

    const newCredential = await this.pollMagicLinkStatus(
      loginResult.data.magic_link_token,
      credential.email,
      quiet,
    );

    // Check if re-login returned a different org than expected
    const activeOrg = await this.configManager.getActiveOrg();
    if (activeOrg && newCredential.org_id !== activeOrg) {
      // Save the credential for the org we actually logged into
      await this.credentialStore.save(newCredential);
      // Switch active org to match
      await this.configManager.setActiveOrg(newCredential.org_id);
      if (!quiet) {
        console.error(Formatter.status('warning', `You were signed into a different organization: ${newCredential.org_name}. Your active organization has been updated.`));
      }
      throw new AuthError(
        'Please run your command again.',
        'The active organization was switched during re-authentication.',
      );
    }

    // Same org — update credential and continue
    await this.credentialStore.save(newCredential);
    if (!quiet) {
      console.error(Formatter.status('success', 'Re-authenticated successfully'));
    }

    return newCredential.access_token;
  }

  async refreshToken(orgId: string): Promise<void> {
    const credential = await this.credentialStore.get(orgId);
    if (!credential) {
      throw new AuthError('Not signed in', 'Please run agenzo-admin-cli auth login first');
    }

    const result = await this.apiClient.post<RefreshResponse>(
      '/auth/refresh',
      { type: 'bearer', token: credential.access_token },
      { refresh_token: credential.refresh_token },
    );

    if (!result.success) {
      if (result.errorCode === 1002) {
        throw new AuthError('Session expired', 'Please run agenzo-admin-cli auth login again');
      }
      throw new AuthError(
        `Token refresh failed: [${result.errorCode}] ${result.errorMessage}`,
        'Please run agenzo-admin-cli auth login again',
      );
    }

    credential.access_token = result.data.access_token;
    credential.refresh_token = result.data.refresh_token;

    // Handle expires_at: backend returns ISO string, we need unix timestamp
    if (result.data.access_token_expires_at) {
      credential.access_token_expires_at = result.data.access_token_expires_at;
    } else if (result.data.expires_at) {
      credential.access_token_expires_at = Math.floor(new Date(result.data.expires_at).getTime() / 1000);
    }

    await this.credentialStore.save(credential);
  }

  /**
   * Execute an authenticated API call with automatic token recovery.
   * If the call returns 1002 (token invalid), attempts refresh → re-login → retry once.
   */
  async executeWithAuth<T>(
    apiFn: (token: string) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    const token = await this.getValidAccessToken();
    const result = await apiFn(token);

    if (!result.success && result.errorCode === 1002) {
      // Token rejected server-side — attempt recovery
      const freshToken = await this.recoverToken();
      return apiFn(freshToken);
    }

    return result;
  }

  /**
   * Attempt token refresh; if that fails, fall back to auto re-login.
   */
  private async recoverToken(): Promise<string> {
    const orgId = await this.configManager.getActiveOrg();
    if (!orgId) {
      throw new AuthError('Not signed in', 'Please run agenzo-admin-cli auth login first');
    }

    const credential = await this.credentialStore.get(orgId);
    if (!credential) {
      throw new AuthError('Not signed in', 'Please run agenzo-admin-cli auth login first');
    }

    try {
      await this.refreshToken(orgId);
      const refreshed = await this.credentialStore.get(orgId);
      return refreshed!.access_token;
    } catch {
      return this.autoReLogin(credential);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

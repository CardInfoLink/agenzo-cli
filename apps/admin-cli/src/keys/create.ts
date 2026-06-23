import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  KeyStore,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  IdempotencyKeyRequiredError,
} from '@agenzo/cli-core';
import type { ApiKey } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';
import { resolveScopes } from './scope.js';
import type { CommandResult } from '@agenzo/cli-core';

export function registerCreateCommand(
  parent: Command,
  deps: {
    apiClient: ApiClient;
    authService: AuthService;
    keyStore: KeyStore;
    configManager: ConfigManager;
  },
): void {
  const cmd = parent
    .command('create')
    .description('Create an API Key')
    .option('--developer-id <developer_id>', 'Developer ID (e.g. dev_01KPX...)')
    .option('--key-name <key_name>', 'Key name (e.g. Production Key)')
    .option(
      '--scope <scope>',
      'Comma-separated CLI scopes: token,merchant,payment (default: all three)',
    )
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const developerId = await PromptEngine.resolveInput(opts.developerId, {
      message: 'Developer ID (e.g. dev_01KPX...):',
    });
    const name = await PromptEngine.resolveInput(opts.keyName, {
      message: 'Key name (e.g. Production Key):',
    });

    // Resolve scopes: --scope flag (validated) > --yes default-all > interactive
    // multi-select. Sent to the backend as a `scope` array (cli-design §2.4.14).
    const scope = await resolveScopes(
      opts.scope as string | undefined,
      Boolean(opts.yes),
    );

    // --idempotency-key is mandatory on every server write; the CLI never
    // auto-generates it. When absent, prompt for it interactively. In
    // non-interactive mode (--yes) prompting would hang, so require the flag.
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (opts.yes) {
        throw new IdempotencyKeyRequiredError('keys create');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }
    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.authService.executeWithAuth((token) =>
      deps.apiClient.post<ApiKey>(
        '/keys/create',
        { type: 'bearer', token },
        { developer_id: developerId, name, scope },
        extraHeaders,
      ),
    );

    if (!result.success) {
      // Throw so the top-level handler owns the error envelope + exit code.
      throw CliError.fromApi(result);
    }

    const key = result.data;
    // The backend now persists and echoes `scope`. Keep this fallback as a
    // defensive no-op for older servers / edge responses that omit it, so the
    // payload/table always show the granted scope.
    if (!key.scope || key.scope.length === 0) {
      key.scope = scope;
    }

    // Persist the full plaintext key (written only on create/rotate).
    const orgId = await deps.configManager.getActiveOrg();
    if (orgId && key.api_key) {
      await deps.keyStore.add(orgId, {
        key_id: key.id,
        developer_id: key.developer_id,
        name: key.name,
        key_value: key.api_key,
        created_at: key.created_at,
      });
    }

    // Status + one-time-secret warning are logs → stderr (never stdout), and
    // only in table mode. In json mode everything here is silent: the key is
    // already part of the stdout payload, so agent consumers get it cleanly.
    notify(format, 'success', 'API Key created');
    if (format === 'table') {
      console.error(Formatter.status('warning', `API Key: ${key.api_key}`));
      console.error(
        Formatter.status('warning', 'Save it now — this key is shown only once'),
      );
    }

    const cmdResult: CommandResult<ApiKey> = {
      data: key,
      text: () =>
        Formatter.keyValue([
          ['Name', key.name],
          ['Scope', (key.scope ?? []).join(', ')],
          ['Status', key.status],
        ]),
    };
    await renderWithContext(cmdResult, { format }, deps.configManager);
  });
}

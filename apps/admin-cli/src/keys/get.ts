import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  resolveFormat,
  CliError,
} from '@agenzo/cli-core';
import type { ApiKey } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';
import type { CommandResult } from '@agenzo/cli-core';

/** Strip the one-time plaintext key so read commands never expose a secret. */
function toMetadata(key: ApiKey): ApiKey {
  const { api_key: _api_key, ...metadata } = key;
  return metadata;
}

export function registerGetCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  const cmd = parent.command('get <key_id>').description('View API Key details');

  cmd.action(async (keyId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const result = await deps.authService.executeWithAuth((token) =>
      deps.apiClient.get<ApiKey>(
        `/keys/${keyId}`,
        { type: 'bearer', token },
      ),
    );

    if (!result.success) {
      throw CliError.fromApi(result);
    }

    // Metadata only — never expose the plaintext key on a read command.
    const k = toMetadata(result.data);

    const cmdResult: CommandResult<ApiKey> = {
      data: k,
      text: () =>
        Formatter.keyValue([
          ['Key ID', k.id],
          ['Developer ID', k.developer_id],
          ['Name', k.name],
          ['Scope', (k.scope ?? []).join(', ')],
          ['Status', k.status],
          ['Last Used', k.last_used_at ? Formatter.formatTime(k.last_used_at) : 'Never'],
          ['Created', Formatter.formatTime(k.created_at)],
        ]),
    };
    await renderWithContext(cmdResult, { format }, deps.configManager);
  });
}

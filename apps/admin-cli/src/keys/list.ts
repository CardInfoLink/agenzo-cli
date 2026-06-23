import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
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

export function registerListCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  const cmd = parent
    .command('list')
    .description('List API Keys')
    .option('--developer-id <developer_id>', 'Developer ID (e.g. dev_01KPX...)');

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const developerId = await PromptEngine.resolveInput(opts.developerId, {
      message: 'Developer ID (e.g. dev_01KPX...):',
    });

    const result = await deps.authService.executeWithAuth((token) =>
      deps.apiClient.get<ApiKey[]>(
        '/keys',
        { type: 'bearer', token },
        { developer_id: developerId },
      ),
    );

    if (!result.success) {
      throw CliError.fromApi(result);
    }

    // Metadata only — never expose the plaintext key on a read command.
    const keys = result.data.map(toMetadata);

    const cmdResult: CommandResult<{ keys: ApiKey[]; page: { next_cursor: string | null; has_more: boolean } }> = {
      data: { keys, page: { next_cursor: null, has_more: false } },
      text: () => {
        if (keys.length === 0) {
          return Formatter.status('info', 'No API Keys found');
        }
        const headers = ['ID', 'Developer', 'Name', 'Scope', 'Status', 'Last Used'];
        const rows = keys.map((k) => [
          k.id,
          k.developer_id,
          k.name,
          (k.scope ?? []).join(','),
          k.status,
          k.last_used_at ? Formatter.formatTime(k.last_used_at) : 'Never',
        ]);
        return Formatter.table(headers, rows);
      },
    };
    await renderWithContext(cmdResult, { format }, deps.configManager);
  });
}

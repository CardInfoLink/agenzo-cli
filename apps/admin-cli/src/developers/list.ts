import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  resolveFormat,
  CliError,
  CommandResult,
} from '@agenzo/cli-core';
import type { Developer } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';

export function registerListCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  parent
    .command('list')
    .description('List all developers')
    .action(async (_options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const result = await deps.authService.executeWithAuth((token) =>
        deps.apiClient.get<Developer[]>(
          '/developers',
          { type: 'bearer', token },
        ),
      );

      if (!result.success) {
        throw CliError.fromApi(result);
      }

      const developers = result.data;
      const commandResult: CommandResult<{ developers: Developer[]; page: { next_cursor: string | null; has_more: boolean } }> = {
        data: { developers, page: { next_cursor: null, has_more: false } },
        text: () => {
          if (developers.length === 0) {
            return Formatter.status('info', 'No developers found');
          }
          const headers = ['ID', 'Name', 'Email', 'Status'];
          const rows = developers.map((d) => [d.id, d.name, d.email, d.status]);
          return Formatter.table(headers, rows);
        },
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

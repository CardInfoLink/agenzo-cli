import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  CommandResult,
  resolveFormat,
  CliError,
} from '@agenzo/cli-core';
import type { Organization } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';

export function registerMeCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  parent
    .command('get')
    .description('View current organization')
    .action(async (_options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const result = await deps.authService.executeWithAuth((token) =>
        deps.apiClient.get<Organization>(
          '/organizations/me',
          { type: 'bearer', token },
        ),
      );

      if (!result.success) {
        // Throw so the top-level handler owns the error envelope + exit code.
        throw CliError.fromApi(result);
      }

      const org = result.data;
      const commandResult: CommandResult<Organization> = {
        data: org,
        text: () =>
          Formatter.keyValue([
            ['Org ID', org.id],
            ['Name', org.name],
            ['Email', org.email],
            ['Status', org.status],
            ['Created', Formatter.formatTime(org.created_at)],
            ['Updated', Formatter.formatTime(org.updated_at)],
          ]),
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

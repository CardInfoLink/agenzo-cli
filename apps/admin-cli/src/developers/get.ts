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

export function registerGetCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  parent
    .command('get <developer_id>')
    .description('View developer details')
    .action(async (developerId: string, _options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const result = await deps.authService.executeWithAuth((token) =>
        deps.apiClient.get<Developer>(
          `/developers/${developerId}`,
          { type: 'bearer', token },
        ),
      );

      if (!result.success) {
        throw CliError.fromApi(result);
      }

      const dev = result.data;
      const commandResult: CommandResult<Developer> = {
        data: dev,
        text: () =>
          Formatter.keyValue([
            ['ID', dev.id],
            ['Name', dev.name],
            ['Email', dev.email],
            ['Status', dev.status],
            ['Billing Mode', dev.billing_mode ?? '-'],
            ['Bank Account', dev.bank_account?.account_number ?? '-'],
            ['Bank Name', dev.bank_account?.bank_name ?? '-'],
            ['Bank Country', dev.bank_account?.bank_country ?? '-'],
            ['Created', Formatter.formatTime(dev.created_at)],
            ['Updated', Formatter.formatTime(dev.updated_at)],
          ]),
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  CommandResult,
} from '@agenzo/cli-core';
import type { SettlementAccount } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';

export function registerGetCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  parent
    .command('get')
    .description("Query a developer's settlement account")
    .option('--developer-id <id>', 'Developer ID to query')
    .action(async (options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const developerId = await PromptEngine.resolveInput(options.developerId, {
        message: 'Developer ID (e.g. dev_01HZ...):',
      });

      const result = await deps.authService.executeWithAuth((token) =>
        deps.apiClient.get<SettlementAccount | null>(
          '/accounts',
          { type: 'bearer', token },
          { developer_id: developerId },
        ),
      );

      if (!result.success) {
        throw CliError.fromApi(result);
      }

      const account = result.data;

      // Auto-provisioning means an absent account only happens for legacy
      // developers. The backend returns data:null with a message; render an
      // info line in table mode and `account: null` in json mode.
      if (!account) {
        notify(
          format,
          'info',
          'No settlement account found for this developer. Complete offline contract signing first.',
        );
        await renderWithContext(
          { data: { account: null }, text: () => '' },
          { format },
          deps.configManager,
        );
        return;
      }

      const commandResult: CommandResult<SettlementAccount> = {
        data: account,
        text: () =>
          Formatter.keyValue([
            ['Account ID', account.id],
            ['Developer ID', account.developer_id],
            ['Balance', String(account.balance)],
            ['Currency', account.currency],
            ['Status', account.status],
            ['Created', Formatter.formatTime(account.created_at)],
            ['Updated', Formatter.formatTime(account.updated_at)],
          ]),
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

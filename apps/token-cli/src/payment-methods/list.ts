import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { PaymentMethod } from '../types/api.js';

/**
 * `payment-methods list` — list payment methods (§3.4.0.2).
 *
 * GET /payment-methods with X-Api-Key header.
 * Optional --member flag maps to ?member_id= query param.
 * Table headers: ID / Type / Brand / First 6 / Last 4 / Status.
 * Empty list → info message (no table). Missing brand/first6/last4 → `-`.
 */
export function registerListCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list')
    .description('List payment methods')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--member <member_id>', 'Filter by member ID');

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build query params
    const params: Record<string, string> = {};
    if (opts.member) {
      params.member_id = opts.member as string;
    }

    const result = await deps.apiClient.get<PaymentMethod[]>(
      '/payment-methods',
      { type: 'api-key', key: apiKey },
      Object.keys(params).length > 0 ? params : undefined,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const methods = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<{ payment_methods: PaymentMethod[] }> = {
      data: { payment_methods: methods },
      text: () => {
        if (methods.length === 0) {
          return Formatter.status('info', 'No payment methods found');
        }
        const headers = ['ID', 'Type', 'Brand', 'First 6', 'Last 4', 'Status'];
        const rows = methods.map((m) => [
          m.id,
          m.type,
          m.brand || '-',
          m.first6 || '-',
          m.last4 || '-',
          m.status,
        ]);
        return Formatter.table(headers, rows);
      },
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

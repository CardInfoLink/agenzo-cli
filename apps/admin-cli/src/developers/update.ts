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
  IdempotencyKeyRequiredError,
  CommandResult,
} from '@agenzo/cli-core';
import type { Developer } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';
import { addBankAccountOptions, resolveOptionalBankAccount } from './bank-account.js';

export function registerUpdateCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  const cmd = parent
    .command('update <developer_id>')
    .description('Update developer info')
    .option('--name <name>', 'New name')
    .option('--email <email>', 'New email')
    .option('--idempotency-key <key>', 'Idempotency key forwarded as the Idempotency-Key header');
  addBankAccountOptions(cmd).action(async (developerId: string, options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.email) body.email = options.email;

      // Bank account replacement is optional on update: only resolved (and
      // required to be complete) when at least one --bank-* flag is supplied.
      // One account per developer — replaced wholesale, no partial patching.
      const bankAccount = await resolveOptionalBankAccount(
        {
          bankBeneficiaryName: options.bankBeneficiaryName,
          bankAccountNumber: options.bankAccountNumber,
          bankName: options.bankName,
          bankCountry: options.bankCountry,
          bankSwiftCode: options.bankSwiftCode,
          bankAddress: options.bankAddress,
          bankRoutingNumber: options.bankRoutingNumber,
        },
        command,
      );
      if (bankAccount) {
        body.bank_account = bankAccount;
      }

      // --idempotency-key is mandatory on every server write; the CLI never
      // auto-generates it. When absent, prompt for it interactively. In
      // non-interactive mode (--yes) prompting would hang, so require the flag.
      let idempotencyKey = options.idempotencyKey as string | undefined;
      if (!idempotencyKey) {
        if (command.optsWithGlobals().yes) {
          throw new IdempotencyKeyRequiredError('developers update');
        }
        idempotencyKey = await PromptEngine.resolveInput(undefined, {
          message: 'Idempotency key (unique per write, for safe retry):',
          validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
        });
      }
      const extraHeaders: Record<string, string> = {
        'Idempotency-Key': String(idempotencyKey),
      };

      const result = await deps.authService.executeWithAuth((token) =>
        deps.apiClient.post<Developer>(
          `/developers/${developerId}/update`,
          { type: 'bearer', token },
          body,
          extraHeaders,
        ),
      );

      if (!result.success) {
        throw CliError.fromApi(result);
      }

      const dev = result.data;
      const commandResult: CommandResult<Developer> = {
        data: dev,
        note: 'Developer updated',
        text: () =>
          Formatter.keyValue([
            ['ID', dev.id],
            ['Name', dev.name],
            ['Email', dev.email],
            ['Status', dev.status],
            ['Bank Account', String(dev.bank_account?.account_number ?? '-')],
          ]),
      };

      // Status / progress lines belong on stderr (table mode only); stdout
      // carries only the payload.
      if (commandResult.note) {
        notify(format, 'success', commandResult.note);
      }
      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

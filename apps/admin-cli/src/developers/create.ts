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
import { resolveBillingMode } from './billing-mode.js';
import { addBankAccountOptions, resolveBankAccount } from './bank-account.js';

export function registerCreateCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  const cmd = parent
    .command('create')
    .description('Create a developer')
    .option('--developer-name <name>', 'Developer name')
    .option('--developer-email <email>', 'Developer email')
    .option(
      '--billing-mode <mode>',
      'Billing mode: pay_per_call | monthly_settlement (default: pay_per_call)',
    )
    .option(
      '--settlement-currency <code>',
      'ISO 4217 currency for the settlement account (e.g. USD, CNY). Only for monthly_settlement. Defaults to platform setting (USD).',
    )
    .option('--idempotency-key <key>', 'Idempotency key forwarded as the Idempotency-Key header');
  addBankAccountOptions(cmd).action(async (options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const name = await PromptEngine.resolveInput(options.developerName, {
        message: 'Developer name:',
      });
      const email = await PromptEngine.resolveInput(options.developerEmail, {
        message: 'Developer email:',
      });

      // Validate --billing-mode locally (defaults to pay_per_call). An invalid
      // value throws ValidationError -> PARAM_INVALID / exit 1.
      const billingMode = resolveBillingMode(options.billingMode);

      // Bank account is mandatory regardless of billing_mode — every developer
      // needs a payout target on file before it can receive transfers.
      const bankAccount = await resolveBankAccount(
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

      // --idempotency-key is mandatory on every server write; the CLI never
      // auto-generates it. When absent, prompt for it interactively. In
      // non-interactive mode (--yes) prompting would hang, so require the flag.
      let idempotencyKey = options.idempotencyKey as string | undefined;
      if (!idempotencyKey) {
        if (command.optsWithGlobals().yes) {
          throw new IdempotencyKeyRequiredError('developers create');
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
          '/developers/create',
          { type: 'bearer', token },
          {
            name,
            email,
            billing_mode: billingMode,
            bank_account: bankAccount,
            ...(options.settlementCurrency
              ? { settlement_currency: options.settlementCurrency as string }
              : {}),
          },
          extraHeaders,
        ),
      );

      if (!result.success) {
        throw CliError.fromApi(result);
      }

      const dev = result.data;
      // Preserve the original handler's defensive `id ?? developer_id` read,
      // type-safely (the backend has historically returned either field).
      const idDisplay = String(
        dev.id ?? (dev as { developer_id?: string }).developer_id ?? '-',
      );
      const commandResult: CommandResult<Developer> = {
        data: dev,
        note: 'Developer created',
        text: () =>
          Formatter.keyValue([
            ['ID', idDisplay],
            ['Org ID', String(dev.organization_id ?? '-')],
            ['Name', String(dev.name ?? '-')],
            ['Email', String(dev.email ?? '-')],
            ['Status', String(dev.status ?? '-')],
            ['Billing Mode', String(dev.billing_mode ?? '-')],
            ['Bank Account', String(dev.bank_account?.account_number ?? '-')],
            ['Bank Name', String(dev.bank_account?.bank_name ?? '-')],
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

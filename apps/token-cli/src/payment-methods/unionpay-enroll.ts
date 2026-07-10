import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { PaymentMethod } from '../types/api.js';

/**
 * `payment-methods unionpay-enroll` — start UnionPay (UPI Agent Pay) card
 * enrollment and return immediately (no polling).
 *
 * This is the non-blocking counterpart to `payment-methods add --payment-brand
 * unionpay`: it POSTs /payment-methods/create with `payment_brand=unionpay`,
 * prints the returned `enroll_url` (+ pm id + correlation id), then exits.
 * Unlike `add --payment-brand unionpay`, it does NOT poll for the terminal
 * card-binding status — callers poll separately via
 * `payment-methods unionpay-status <pm_id>` once the user finishes
 * authenticating in the browser/Sheet.
 *
 * Intended for programmatic callers (e.g. the agent orchestrator) that need
 * the enroll_url synchronously to render a bind-card card, rather than a CLI
 * operator waiting at the terminal for the async webhook result. Not
 * advertised in the SKILL/README (mirrors dropin-create / dropin-status).
 */
export function registerUnionpayEnrollCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('unionpay-enroll')
    .description('Start UnionPay card enrollment and return the enroll_url (no polling)')
    .option('--api-key <key>', 'API Key for authentication')
    .option(
      '--member <id>',
      'End-user member id this card belongs to (required)',
    )
    .option('--email <email>', 'Email (required by the UnionPay enrollment API)')
    .option(
      '--return-url <url>',
      'Optional front-end redirect URL after UPI enrollment completes',
    );

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    let member = opts.member as string | undefined;
    if (!member) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --member <id> for unionpay-enroll (required in --yes mode)',
        );
      }
      member = await PromptEngine.resolveInput(undefined, {
        message: 'Member ID (end-user identity this card belongs to):',
        validate: (v) => v.trim().length > 0 || 'Member ID is required',
      });
    }

    const email = await PromptEngine.resolveInput(opts.email as string | undefined, {
      message: 'Email:',
    });

    const result = await deps.apiClient.post<PaymentMethod>(
      '/payment-methods/create',
      { type: 'api-key', key: apiKey },
      {
        type: 'card',
        payment_brand: 'unionpay',
        member_id: member,
        email,
        ...(opts.returnUrl ? { return_url: String(opts.returnUrl) } : {}),
      },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const pm = result.data;

    notify(format, 'success', 'Card binding initiated');

    const configManager = new ConfigManager();
    const cmdResult: CommandResult<PaymentMethod> = {
      data: pm,
      text: () =>
        Formatter.keyValue([
          ['ID', pm.id],
          ['Status', pm.status],
          ['Enroll URL', pm.enroll_url ?? '-'],
          ['Correlation ID', pm.correlation_id ?? '-'],
        ]),
    };

    await renderWithContext(cmdResult, { format }, configManager);

    notify(
      format,
      'info',
      'Open the Enroll URL in a browser to complete card binding, then check status with: ' +
        `agenzo-token-cli payment-methods unionpay-status ${pm.id}`,
    );
  });
}

import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  PromptEngine,
  resolveFormat,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { PaymentMethod } from '../types/api.js';

/**
 * `payment-methods dropin-status [pm_id]` — query the current Drop-in binding
 * status for a payment method, once (no polling).
 *
 * This is the status-check half of `payment-methods add --mode dropin`: it
 * reads GET /payment-methods/verification/status?payment_method_id=<pm_id>
 * and prints the current status, then exits. Callers (e.g. the agent
 * orchestrator) poll this on their own cadence after minting a session with
 * `payment-methods dropin-create`, instead of letting the CLI block for 30
 * minutes.
 *
 * The payment method id may be supplied either as the positional `<pm_id>`
 * (CLI operators) or via `--payment-method-id <id>`. The flag form exists for
 * programmatic callers like the agent orchestrator, whose CLI gateway only
 * passes `--flag value` pairs and cannot send positional arguments.
 *
 * Status enum: PENDING | ACTIVE | FAILED | DISABLED | EXPIRED.
 * Not advertised in the SKILL/README.
 */
export function registerDropinStatusCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('dropin-status [pm_id]')
    .description('Query the current Drop-in binding status for a payment method (single check)')
    .option('--api-key <key>', 'API Key for authentication')
    .option(
      '--payment-method-id <id>',
      'Payment method id to query (alternative to the positional <pm_id>, for programmatic callers that pass flags only)',
    );

  cmd.action(async (pmIdArg: string | undefined) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    // Accept the pm id from the positional arg or the --payment-method-id flag
    // (the orchestrator gateway can only pass flags), else prompt interactively.
    const pmId = await PromptEngine.resolveInput(
      pmIdArg ?? (opts.paymentMethodId as string | undefined),
      { message: 'Payment method id:' },
    );

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // GET /payment-methods/verification/status?payment_method_id=<pm_id>
    const result = await deps.apiClient.get<PaymentMethod>(
      '/payment-methods/verification/status',
      { type: 'api-key', key: apiKey },
      { payment_method_id: pmId },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const pm = result.data;

    const entries: [string, string][] = [['ID', pm.id ?? pmId]];
    if (pm.brand) entries.push(['Brand', pm.brand]);
    if (pm.first6) entries.push(['First 6', pm.first6]);
    if (pm.last4) entries.push(['Last 4', pm.last4]);
    entries.push(['Status', pm.status]);

    const configManager = new ConfigManager();
    const cmdResult: CommandResult<PaymentMethod> = {
      data: pm,
      text: () => Formatter.keyValue(entries),
    };

    await renderWithContext(cmdResult, { format }, configManager);
  });
}

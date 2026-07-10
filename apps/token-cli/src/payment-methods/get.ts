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
import { attachSchemaHelp, pmGetSchema } from '../verb-schema.js';

/**
 * `payment-methods get [pm_id]` — show a single payment method (§3.4.0.3).
 *
 * Reads: GET /payment-methods/<pm_id> (X-Api-Key).
 * Output: keyValue. Brand / First 6 / Last 4 appear only when their
 * corresponding fields are non-empty/non-null (conditional inclusion).
 *
 * The payment method id may be supplied either as the positional `<pm_id>`
 * (CLI operators) or via `--id <id>` (programmatic callers like the agent
 * orchestrator, whose CLI gateway only passes `--flag value` pairs and
 * cannot send positional arguments — mirrors unionpay-status / dropin-status).
 */
export function registerGetCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('get [pm_id]')
    .description('Get a payment method by ID')
    .option('--api-key <key>', 'API key for authentication')
    .option(
      '--id <id>',
      'Payment method id to query (alternative to the positional <pm_id>, for programmatic callers that pass flags only)',
    );

  attachSchemaHelp(cmd, pmGetSchema);

  cmd.action(async (pmIdArg: string | undefined) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const pmId = await PromptEngine.resolveInput(pmIdArg ?? (opts.id as string | undefined), {
      message: 'Payment method id:',
    });

    // Resolve API key — prompt interactively if not provided via flag
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // GET /payment-methods/<pm_id>
    const result = await deps.apiClient.get<PaymentMethod>(
      `/payment-methods/${pmId}`,
      { type: 'api-key', key: apiKey },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const pm = result.data;

    // Build keyValue entries — Brand/First 6/Last 4 only when non-empty
    const entries: [string, string][] = [
      ['ID', pm.id],
      ['Type', pm.type],
    ];

    if (pm.brand) {
      entries.push(['Brand', pm.brand]);
    }
    if (pm.first6) {
      entries.push(['First 6', pm.first6]);
    }
    if (pm.last4) {
      entries.push(['Last 4', pm.last4]);
    }

    entries.push(['Status', pm.status]);
    entries.push(['Created', Formatter.formatTime(pm.created_at)]);

    const configManager = new ConfigManager();
    const cmdResult: CommandResult<PaymentMethod> = {
      data: pm,
      text: () => Formatter.keyValue(entries),
    };

    await renderWithContext(cmdResult, { format }, configManager);
  });
}

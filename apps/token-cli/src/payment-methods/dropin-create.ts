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
import type { DropinCreateResponse } from '../types/api.js';

/**
 * `payment-methods dropin-create` — mint a Drop-in session and return
 * immediately (no polling).
 *
 * This is the non-blocking half of `payment-methods add --mode dropin`: it
 * POSTs /payment-methods/dropin/create with the developer email, prints the
 * minted `session_id` (+ pm id) so the caller can initialise the Drop-in SDK
 * in their own front-end, then exits. Unlike `add --mode dropin`, it does NOT
 * poll verification/status — callers poll separately via
 * `payment-methods dropin-status <pm_id>` once the user finishes in the browser.
 *
 * Intended for programmatic callers (e.g. the agent orchestrator) that need the
 * session id synchronously to render an add-card card, rather than a CLI
 * operator who waits at the terminal. Not advertised in the SKILL/README.
 */
export function registerDropinCreateCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('dropin-create')
    .description('Mint a Drop-in session and return the session id (no polling)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--email <email>', 'Email used as the Drop-in session reference');

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    const email = await PromptEngine.resolveInput(opts.email as string | undefined, {
      message: 'Email:',
    });

    // POST /payment-methods/dropin/create — backend creates a PENDING PM and
    // mints the Drop-in session for the front-end SDK. Returns synchronously.
    const sessionResult = await deps.apiClient.post<DropinCreateResponse>(
      '/payment-methods/dropin/create',
      { type: 'api-key', key: apiKey },
      { email },
    );

    if (!sessionResult.success) {
      throw CliError.fromApi(sessionResult, { auth: 'api-key' });
    }

    const session = sessionResult.data;

    notify(format, 'success', 'Drop-in session created');

    const configManager = new ConfigManager();
    const result: CommandResult<DropinCreateResponse> = {
      data: session,
      text: () =>
        Formatter.keyValue([
          ['PM ID', session.id],
          ['Session ID', session.session_id || '-'],
          ['Merchant Trans ID', session.merchant_trans_id || '-'],
          ['Status', session.status],
        ]),
    };

    await renderWithContext(result, { format }, configManager);

    notify(
      format,
      'info',
      'Use the Session ID to add the payment method via the Drop-in SDK, then poll: agenzo-token-cli payment-methods dropin-status <pm_id> --api-key <your_key>',
    );
  });
}

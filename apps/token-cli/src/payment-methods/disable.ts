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
} from '@agenzo/cli-core';
import type { CommandResult, DisableResult } from '@agenzo/cli-core';

/**
 * `payment-methods disable <pm_id>` — disable a payment method (§3.4.0.4).
 *
 * POST /payment-methods/<pm_id>/disable (no body).
 * Output: `✓ Payment method <id> disabled` + Status + Revoked tokens.
 * Idempotency: --idempotency-key required in --yes mode (Requirement 6.3).
 */
export function registerDisableCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('disable <pm_id>')
    .description('Disable a payment method')
    .option('--api-key <key>', 'API key for authentication')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  cmd.action(async (pmId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Idempotency key handling (Requirement 6.3):
    // In --yes mode, --idempotency-key is mandatory — never auto-generate, never send request.
    // In interactive mode, prompt if not provided.
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (opts.yes) {
        throw new IdempotencyKeyRequiredError('payment-methods disable');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.apiClient.post<DisableResult>(
      `/payment-methods/${pmId}/disable`,
      { type: 'api-key', key: apiKey },
      undefined,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    // Status line → stderr (json mode stays silent per §5)
    notify(format, 'success', `Payment method ${pmId} disabled`);

    const cmdResult: CommandResult<DisableResult> = {
      data,
      text: () =>
        Formatter.keyValue([
          ['Status', data.status],
          ['Revoked tokens', String(data.revoked_tokens_count ?? 0)],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(cmdResult, { format }, configManager);
  });
}

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
  DisableResult,
} from '@agenzo/cli-core';
import { AuthService } from '../auth/auth-service.js';
import type { CommandResult } from '@agenzo/cli-core';

export function registerDisableCommand(
  parent: Command,
  deps: { apiClient: ApiClient; authService: AuthService; configManager: ConfigManager },
): void {
  const cmd = parent
    .command('disable <key_id>')
    .description('Disable API Key')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  cmd.action(async (keyId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    // --idempotency-key is mandatory on every server write; the CLI never
    // auto-generates it. When absent, prompt for it interactively. In
    // non-interactive mode (--yes) prompting would hang, so require the flag.
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (opts.yes) {
        throw new IdempotencyKeyRequiredError('keys disable');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }
    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.authService.executeWithAuth((token) =>
      deps.apiClient.post<DisableResult>(
        `/keys/${keyId}/disable`,
        { type: 'bearer', token },
        undefined,
        extraHeaders,
      ),
    );

    if (!result.success) {
      throw CliError.fromApi(result);
    }

    const disableResult = result.data;

    // Status line is a log → stderr, table mode only (json stays silent).
    notify(format, 'success', `API Key ${keyId} disabled`);

    const cmdResult: CommandResult<DisableResult> = {
      data: disableResult,
      text: () =>
        Formatter.keyValue([
          ['Status', disableResult.status],
        ]),
    };
    await renderWithContext(cmdResult, { format }, deps.configManager);
  });
}

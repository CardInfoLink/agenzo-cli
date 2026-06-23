import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  PromptEngine,
  Formatter,
  ConfigManager,
  resolveFormat,
  notify,
  IdempotencyKeyRequiredError,
} from '@agenzo/cli-core';
import { AuthService } from './auth-service.js';
import type { CommandResult } from '@agenzo/cli-core';

/**
 * Machine payload for `auth login` (`--format json`).
 *
 * Shape matches cli-guide §6.2: `organization_id` + nested `organization`
 * object + `email`. Tokens are deliberately excluded — Bearer
 * `access_token` / `refresh_token` never reach stdout in any format
 * (Requirement 6.1). `is_new_registration` drives only the stderr status
 * line, not the stdout payload.
 */
interface LoginData {
  organization_id: string;
  organization: { id: string; name: string };
  email: string;
}

export function registerLoginCommand(
  program: Command,
  deps: { authService: AuthService; configManager: ConfigManager },
): void {
  program
    .command('login')
    .description('Sign in to Agent Payment API')
    .option('--email <email>', 'Email address')
    .option(
      '--idempotency-key <key>',
      'Forwarded verbatim as the Idempotency-Key header on login/registration',
    )
    .action(async (options, command) => {
      // Global `--format` is added by the top-level wiring (task 7.1); until
      // then this falls back to AGENZO_FORMAT / the `table` default.
      const format = resolveFormat(command.optsWithGlobals().format);

      const email = await PromptEngine.resolveInput(options.email, {
        message: 'Email:',
      });

      // --idempotency-key is mandatory on every server write; the CLI never
      // auto-generates it. When absent, prompt for it interactively. In
      // non-interactive mode (--yes) prompting would hang, so require the flag.
      let idempotencyKey = options.idempotencyKey as string | undefined;
      if (!idempotencyKey) {
        if (command.optsWithGlobals().yes) {
          throw new IdempotencyKeyRequiredError('auth login');
        }
        idempotencyKey = await PromptEngine.resolveInput(undefined, {
          message: 'Idempotency key (unique per write, for safe retry):',
          validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
        });
      }

      // Forward `--idempotency-key` verbatim; never auto-generate (Requirement 4.3).
      // quiet in json mode so agent consumers get clean output.
      const result = await deps.authService.login(email, {
        idempotencyKey,
        quiet: format === 'json',
      });

      // Status/progress lines are logs, not payload — stderr only, and only in
      // table mode (json mode stays silent for agent consumers).
      const signedInMessage = result.isNewRegistration
        ? 'Registered and signed in'
        : 'Signed in successfully';
      notify(format, 'success', signedInMessage);

      const data: LoginData = {
        organization_id: result.credential.org_id,
        organization: {
          id: result.credential.org_id,
          name: result.credential.org_name,
        },
        email: result.credential.email,
      };

      const commandResult: CommandResult<LoginData> = {
        data,
        text: () =>
          Formatter.keyValue([
            ['Org ID', data.organization_id],
            ['Org Name', data.organization.name],
            ['Email', data.email],
          ]),
        note: signedInMessage,
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

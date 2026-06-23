import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  CredentialStore,
  PromptEngine,
  Formatter,
  CommandResult,
  resolveFormat,
  notify,
  CliError,
  IdempotencyKeyRequiredError,
} from '@agenzo/cli-core';
import type { Organization } from '../types/api.js';
import { AuthService } from '../auth/auth-service.js';

export function registerUpdateCommand(
  parent: Command,
  deps: {
    apiClient: ApiClient;
    authService: AuthService;
    credentialStore: CredentialStore;
    configManager: ConfigManager;
  },
): void {
  parent
    .command('update')
    .description('Update current organization')
    .option('--name <name>', 'New organization name')
    .option('--email <email>', 'New email')
    .option('--idempotency-key <key>', 'Idempotency key forwarded as the Idempotency-Key header')
    .action(async (options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.email) body.email = options.email;

      // --idempotency-key is mandatory on every server write; the CLI never
      // auto-generates it. When absent, prompt for it interactively. In
      // non-interactive mode (--yes) prompting would hang, so require the flag.
      let idempotencyKey = options.idempotencyKey as string | undefined;
      if (!idempotencyKey) {
        if (command.optsWithGlobals().yes) {
          throw new IdempotencyKeyRequiredError('orgs update');
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
        deps.apiClient.post<Organization & {
          magic_link_token?: string;
          expires_at?: string;
        }>(
          '/organizations/me/update',
          { type: 'bearer', token },
          body,
          extraHeaders,
        ),
      );

      if (!result.success) {
        throw CliError.fromApi(result);
      }

      const data = result.data;

      // Email change does NOT update the org inline — the backend returns a
      // magic-link verification payload ({ magic_link_token, expires_at })
      // instead of the Organization. Detect that shape and render it as a
      // pending-verification result rather than an Organization (which would
      // show every field as `undefined`).
      //
      // SECURITY: the `magic_link_token` is a consumable credential that lets
      // its holder complete the email change. Surfacing it on stdout would let
      // the initiator bypass proving control of the new address (and tokens
      // must never enter stdout — cli-standard §3). So we deliberately drop it
      // from the payload and output, and only emit the spec's info line plus a
      // non-sensitive expiry.
      if (data.magic_link_token) {
        notify(
          format,
          'info',
          'Email change requires verification at the new address',
        );
        const verifyResult: CommandResult<{
          status: 'PENDING_EMAIL_VERIFICATION';
          expires_at?: string;
        }> = {
          data: {
            status: 'PENDING_EMAIL_VERIFICATION',
            expires_at: data.expires_at,
          },
          text: () =>
            Formatter.keyValue([
              ['Status', 'PENDING_EMAIL_VERIFICATION'],
              ['Expires At', Formatter.formatTime(data.expires_at)],
            ]),
        };
        await renderWithContext(verifyResult, { format }, deps.configManager);
        return;
      }

      const org = data;

      // Sync local credential cache with updated org info.
      const activeOrg = await deps.configManager.getActiveOrg();
      if (activeOrg) {
        const cred = await deps.credentialStore.get(activeOrg);
        if (cred && options.name) {
          cred.org_name = org.name;
          await deps.credentialStore.save(cred);
        }
      }

      // Status / hint lines are logs — stderr, and only in table mode
      // (json mode stays silent for agent consumers).
      notify(format, 'success', 'Organization updated');

      const commandResult: CommandResult<Organization> = {
        data: org,
        text: () =>
          Formatter.keyValue([
            ['Org ID', org.id],
            ['Name', org.name],
            ['Email', org.email],
            ['Status', org.status],
          ]),
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

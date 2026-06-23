import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  CredentialStore,
  ConfigManager,
  Formatter,
  CommandResult,
  resolveFormat,
  notify,
  AuthError,
  ValidationError,
} from '@agenzo/cli-core';

interface SwitchResult {
  active_org: string;
}

export function registerSwitchCommand(
  parent: Command,
  deps: { credentialStore: CredentialStore; configManager: ConfigManager },
): void {
  parent
    .command('switch <org_id>')
    .description('Switch active organization')
    .action(async (orgId: string, _options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const credential = await deps.credentialStore.get(orgId);
      if (!credential) {
        throw new AuthError(
          `Organization ${orgId} not signed in locally`,
          'Please run agenzo-admin-cli auth login to sign in to this organization',
        );
      }

      // Cross-environment guard: never switch to a credential from another host.
      const currentHost = await deps.configManager.getApiHost();
      if (credential.api_host && credential.api_host !== currentHost) {
        throw new ValidationError(
          `Organization ${orgId} belongs to a different environment (${credential.api_host})`,
        );
      }

      await deps.configManager.setActiveOrg(orgId);

      // Status line is a log — stderr, table mode only (json stays silent).
      notify(format, 'success', `Switched to organization ${orgId}`);

      const commandResult: CommandResult<SwitchResult> = {
        data: { active_org: orgId },
        text: () => Formatter.status('success', `Switched to organization ${orgId}`),
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });
}

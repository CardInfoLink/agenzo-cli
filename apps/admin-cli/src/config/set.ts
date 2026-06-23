import { renderWithContext } from '@agenzo/cli-core';
import { Command } from 'commander';
import {
  ConfigManager,
  CredentialStore,
  Formatter,
  CommandResult,
  resolveFormat,
  resolveApiHost,
  notify,
  type OutputFormat,
} from '@agenzo/cli-core';

const DEFAULT_HOST = 'https://agent.everonet.com';

/** Payload for `config set-host` / `config reset-host` (client-constructed; no API call). */
interface HostResult {
  api_host: string;
  active_org: string | null;
}

/** Payload for `config show` (client-constructed local read; no API call). */
interface ShowResult {
  api_host: string;
  api_path: string;
  active_org: string | null;
}

/**
 * Apply a new API host locally and auto-switch the active org to a stored
 * credential that matches the host (clearing it when none match). All status
 * lines are logs and go to stderr; the returned `CommandResult` carries the
 * payload for the central renderer. Any corrupted/unwritable config surfaces
 * as a `ConfigError` thrown from `ConfigManager`, which the top-level handler
 * owns.
 */
async function applyHost(
  deps: { configManager: ConfigManager; credentialStore: CredentialStore },
  host: string,
  verb: 'set to' | 'reset to',
  format: OutputFormat,
): Promise<CommandResult<HostResult>> {
  // `host` may be a built-in profile name (e.g. "production"); credentials are
  // stored keyed by the resolved URL, so match on the resolved host — matching
  // on the raw profile name would never hit and always clear the active org.
  const resolvedHost = resolveApiHost(host);
  await deps.configManager.setApiHost(resolvedHost);

  // Auto-switch active org to one matching the new host.
  const credentials = await deps.credentialStore.listAll();
  const match = credentials.find((c) => c.api_host === resolvedHost);

  let activeOrg: string | null;
  if (match) {
    await deps.configManager.setActiveOrg(match.org_id);
    activeOrg = match.org_id;
  } else {
    // No matching org — clear active org to prevent cross-env pollution.
    const config = await deps.configManager.load();
    config.active_org = null;
    await deps.configManager.save(config);
    activeOrg = null;
  }

  // Status/info lines are logs — stderr, table mode only (json stays silent
  // so agent consumers get a clean stdout payload).
  notify(format, 'success', `API host ${verb}: ${resolvedHost}`);
  notify(
    format,
    'info',
    match
      ? `Switched to organization: ${match.org_name} (${match.org_id})`
      : 'No organization found for this host. Please run login.',
  );

  return {
    data: { api_host: resolvedHost, active_org: activeOrg },
    // stdout payload projection (table mode). The ✓/ℹ status lines are emitted
    // by `notify` above (stderr) — do NOT repeat them here, or table mode would
    // print each line twice (once on stderr via notify, once on stdout via render).
    text: () =>
      Formatter.keyValue([
        ['API Host', resolvedHost],
        ['Active Org', activeOrg ?? '(none)'],
      ]),
  };
}

export function registerConfigCommand(
  program: Command,
  deps: { configManager: ConfigManager; credentialStore: CredentialStore },
): void {
  const configCmd = program.command('config').description('Manage CLI configuration');

  configCmd
    .command('set-host <host>')
    .description('Set API host or profile (e.g. production, testing, or custom URL)')
    .action(async (host: string, _options, command: Command) => {
      // Global `--format` is added by the top-level wiring (task 7.1); until
      // then this falls back to AGENZO_FORMAT / the `table` default.
      const format = resolveFormat(command.optsWithGlobals().format);

      const result = await applyHost(deps, host, 'set to', format);
      await renderWithContext(result, { format }, deps.configManager);
    });

  configCmd
    .command('show')
    .description('Show current configuration')
    .action(async (_options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const config = await deps.configManager.load();
      const data: ShowResult = {
        api_host: config.api_host,
        api_path: deps.configManager.getApiPath(),
        active_org: config.active_org,
      };

      const commandResult: CommandResult<ShowResult> = {
        data,
        text: () =>
          Formatter.keyValue([
            ['API Host', data.api_host],
            ['API Path', data.api_path],
            ['Active Org', data.active_org ?? '(none)'],
          ]),
      };

      await renderWithContext(commandResult, { format }, deps.configManager);
    });

  configCmd
    .command('reset-host')
    .description('Reset API host to default (https://agent.everonet.com)')
    .action(async (_options, command: Command) => {
      const format = resolveFormat(command.optsWithGlobals().format);

      const result = await applyHost(deps, DEFAULT_HOST, 'reset to', format);
      await renderWithContext(result, { format }, deps.configManager);
    });
}

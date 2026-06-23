import { Command } from 'commander';
import {
  ConfigManager,
  Formatter,
  CliError,
  resolveFormat,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { findService, type ServiceCapability } from './registry.js';

/**
 * Render the full capability as a key/value block for table output.
 */
function formatServiceGet(s: ServiceCapability): string {
  const lines: [string, string][] = [
    ['Service ID', s.service_id],
    ['Name', s.name],
    ['Description', s.description],
    ['Category', s.category],
    ['Version', s.version],
    ['Provider', s.provider],
    ['CLI Noun', s.cli_noun],
    ['Verbs', s.verbs.join(', ')],
    ['Workflow', s.workflow.join(' → ')],
    ['Since', s.since],
    ['Help', s.discovery.help_command],
  ];
  const verbDetail = s.verbs
    .map((v) => `  ${v}: ${s.verb_descriptions[v] ?? ''}`)
    .join('\n');
  return `${Formatter.keyValue(lines)}\nVerb descriptions:\n${verbDetail}`;
}

/**
 * `services get <service-id>` — return a single capability's full metadata
 * (§4.4.1.2), including verb_descriptions / workflow / discovery.
 *
 * Read-only, reads the CLI-bundled registry (D4). A hit is rendered via
 * `renderWithContext` (json carries the profile/endpoint envelope); a miss
 * throws cli-core's `CliError` with code `SERVICE_NOT_FOUND` (exit 1).
 */
export function registerServiceGetCommand(parent: Command): void {
  const cmd = parent
    .command('get <service-id>')
    .description('Retrieve a single merchant service by id');

  cmd.action(async (serviceId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const service = findService(serviceId);
    if (!service) {
      throw new CliError(
        'SERVICE_NOT_FOUND',
        `Service '${serviceId}' was not found in the registry. Run "services list" to see available services.`,
      );
    }

    const configManager = new ConfigManager();
    const commandResult: CommandResult<ServiceCapability> = {
      data: service,
      text: () => formatServiceGet(service),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

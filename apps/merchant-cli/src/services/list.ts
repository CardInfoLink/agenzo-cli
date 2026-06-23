import { Command } from 'commander';
import { ConfigManager, Formatter, resolveFormat, renderWithContext } from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { SERVICE_REGISTRY, type ServiceCapability } from './registry.js';

/**
 * Summary view of a registry entry for `services list` (§4.4.1.1): the
 * discovery-relevant subset — service_id/name/category/provider/cli_noun/
 * version/verbs/since/discovery — without the heavier verb_descriptions /
 * workflow detail (those are returned in full by `services get`).
 */
interface ServiceListItem {
  service_id: string;
  name: string;
  category: string;
  provider: string;
  cli_noun: string;
  version: string;
  verbs: string[];
  since: string;
  discovery: ServiceCapability['discovery'];
}

function toListItem(s: ServiceCapability): ServiceListItem {
  return {
    service_id: s.service_id,
    name: s.name,
    category: s.category,
    provider: s.provider,
    cli_noun: s.cli_noun,
    version: s.version,
    verbs: s.verbs,
    since: s.since,
    discovery: s.discovery,
  };
}

/**
 * `services list` — list available merchant capabilities (§4.4.1.1).
 *
 * Read-only, no `--idempotency-key`. Data source is the CLI-bundled registry
 * (D4), not a live backend feed. Output is wrapped by `renderWithContext` so
 * json carries the profile/endpoint envelope; the table form renders a
 * one-line-per-service summary on stdout.
 */
export function registerServicesListCommand(parent: Command): void {
  const cmd = parent
    .command('list')
    .description('List available merchant services from the registry');

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const services = SERVICE_REGISTRY.map(toListItem);

    const configManager = new ConfigManager();
    const commandResult: CommandResult<{ services: ServiceListItem[] }> = {
      data: { services },
      text: () => {
        if (services.length === 0) {
          return Formatter.status('info', 'No services found');
        }
        const headers = ['Service ID', 'Name', 'Category', 'Provider', 'Version', 'Verbs'];
        const rows = services.map((s) => [
          s.service_id,
          s.name,
          s.category,
          s.provider,
          s.version,
          s.verbs.join(', '),
        ]);
        return Formatter.table(headers, rows);
      },
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

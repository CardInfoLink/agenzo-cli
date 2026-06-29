import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  PromptEngine,
  CliError,
  resolveFormat,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { SERVICE_REGISTRY } from './registry.js';
import { buildLocalCapabilityMap, type LocalCapabilityMap } from './local-caps.js';

/**
 * Summary view of a capability for `services list` output. Lightweight on
 * purpose — the full schema (incl. per-verb detail) is fetched via `services
 * get`. Heavy fields (verb_descriptions / workflow / description / schema_content)
 * are deliberately omitted here.
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
  discovery?: unknown;
}

/**
 * Normalize any capability-like record — a backend discovery item OR a local
 * registry entry — down to the lightweight list summary. Both sources share
 * field names, so one normalizer keeps `list` output identical regardless of
 * where it came from and prevents heavy fields from leaking in.
 */
function toListItem(s: Record<string, unknown>): ServiceListItem {
  return {
    service_id: String(s.service_id ?? ''),
    name: String(s.name ?? ''),
    category: String(s.category ?? ''),
    provider: String(s.provider ?? ''),
    cli_noun: String(s.cli_noun ?? ''),
    version: String(s.version ?? ''),
    verbs: Array.isArray(s.verbs) ? (s.verbs as string[]) : [],
    since: String(s.since ?? ''),
    discovery: s.discovery,
  };
}

/**
 * Gate backend capabilities against what this CLI binary can actually execute.
 *
 * The schema lives on the backend (dynamic); the CLI does NOT bundle it. The
 * gate uses the CLI's own command tree (`localCaps`): a capability is kept only
 * if this CLI registers its `cli_noun`, and its `verbs` are intersected with the
 * locally-registered verbs (so a verb the CLI doesn't implement is never shown).
 * Capabilities with no executable verb are dropped entirely — the Agent never
 * sees a service/verb it cannot run.
 */
function gateByLocalCommands(
  capabilities: ServiceListItem[],
  localCaps: LocalCapabilityMap,
): ServiceListItem[] {
  const gated: ServiceListItem[] = [];
  for (const cap of capabilities) {
    const localVerbs = localCaps[cap.cli_noun];
    if (!localVerbs) continue; // CLI doesn't have this noun at all → hide
    const usableVerbs = (cap.verbs || []).filter((v) => localVerbs.includes(v));
    if (usableVerbs.length === 0) continue; // nothing executable → hide
    gated.push({ ...cap, verbs: usableVerbs });
  }
  return gated;
}

/**
 * `services list` — discover available merchant capabilities.
 *
 * Primary path: call the platform discovery API (`GET /api/discovery/v1/catalog`),
 * then gate the result against this CLI's command tree (see gateByLocalCommands)
 * so only services/verbs this binary can run are shown.
 *
 * Fallback: if the platform is unreachable, fall back to the CLI-bundled local
 * registry (offline usability), gated the same way.
 */
export function registerServicesListCommand(
  parent: Command,
  deps: { discoveryClient: ApiClient; program: Command },
): void {
  const cmd = parent
    .command('list')
    .description('List available merchant services (from platform discovery)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const localCaps = buildLocalCapabilityMap(deps.program);

    let services: ServiceListItem[];

    try {
      // Resolve API key (required for the discovery endpoint).
      const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
        message: 'API Key:',
        type: 'password',
      });

      // Discovery lives at /api/discovery/v1/catalog (host root, not the merchant
      // prefix); deps.discoveryClient is built from the raw host in index.ts.
      const result = await deps.discoveryClient.get<{
        capabilities: Array<Record<string, unknown>>;
      }>('/api/discovery/v1/catalog', { type: 'api-key', key: apiKey });

      if (!result.success) {
        throw CliError.fromApi(result, { auth: 'api-key' });
      }

      services = gateByLocalCommands(
        (result.data.capabilities || []).map(toListItem),
        localCaps,
      );
    } catch {
      // Fallback to local registry when the backend is unreachable.
      services = gateByLocalCommands(
        SERVICE_REGISTRY.map((s) => toListItem(s as unknown as Record<string, unknown>)),
        localCaps,
      );
    }

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

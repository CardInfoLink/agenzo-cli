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
import { findService } from './registry.js';
import { buildLocalCapabilityMap, type LocalCapabilityMap } from './local-caps.js';

/**
 * Render the full capability as a key/value block for table output. Heavy
 * detail (workflow, per-verb descriptions) is appended when present so the
 * human-facing table stays as informative as the JSON payload.
 */
function formatServiceGet(s: Record<string, unknown>): string {
  const lines: [string, string][] = [
    ['Service ID', String(s.service_id ?? '')],
    ['Name', String(s.name ?? '')],
    ['Description', String(s.description ?? s.summary ?? '')],
    ['Category', String(s.category ?? '')],
    ['Version', String(s.version ?? '')],
    ['Provider', String(s.provider ?? '')],
    ['CLI Noun', String(s.cli_noun ?? '')],
    ['Verbs', Array.isArray(s.verbs) ? (s.verbs as string[]).join(', ') : ''],
  ];
  if (Array.isArray(s.workflow) && s.workflow.length > 0) {
    lines.push(['Workflow', (s.workflow as string[]).join(' → ')]);
  }

  const block = Formatter.keyValue(lines);

  const verbDescriptions = s.verb_descriptions as Record<string, string> | undefined;
  if (verbDescriptions && Object.keys(verbDescriptions).length > 0) {
    const detail = Object.entries(verbDescriptions)
      .map(([verb, desc]) => `  ${verb}: ${desc}`)
      .join('\n');
    return `${block}\n\nVerb descriptions:\n${detail}`;
  }
  return block;
}

/**
 * Gate a single backend capability against the CLI's command tree: the
 * `cli_noun` must be registered locally, otherwise the service is treated as
 * not found (the CLI can't execute it, so it must not surface its schema).
 * Verb lists inside the returned payload are intersected with local verbs so a
 * verb the CLI lacks is never advertised to the Agent.
 */
function gateCapability(
  data: Record<string, unknown>,
  localCaps: LocalCapabilityMap,
): Record<string, unknown> | null {
  const noun = String(data.cli_noun ?? '');
  const localVerbs = localCaps[noun];
  if (!localVerbs) return null;

  const out = { ...data };
  // Intersect the top-level verbs[] summary.
  if (Array.isArray(out.verbs)) {
    out.verbs = (out.verbs as string[]).filter((v) => localVerbs.includes(v));
  }
  // Intersect the full schema_content.verbs map when present.
  const schema = out.schema_content as Record<string, unknown> | undefined;
  if (schema && schema.verbs && typeof schema.verbs === 'object') {
    const filtered: Record<string, unknown> = {};
    for (const [verb, def] of Object.entries(schema.verbs as Record<string, unknown>)) {
      if (localVerbs.includes(verb)) filtered[verb] = def;
    }
    out.schema_content = { ...schema, verbs: filtered };
  }
  return out;
}

/**
 * `services get <service-id>` — retrieve a single capability's full metadata
 * including the complete schema_content (the Agent reads this to learn how to
 * use the service).
 *
 * Primary path: `GET /api/discovery/v1/catalog/<service-id>` → full schema, then
 * gated against the CLI command tree (noun must exist; verbs intersected).
 * Fallback: local registry (basic metadata, no schema_content).
 */
export function registerServiceGetCommand(
  parent: Command,
  deps: { discoveryClient: ApiClient; program: Command },
): void {
  const cmd = parent
    .command('get <service-id>')
    .description('Retrieve a single merchant service by id (includes full schema)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');

  cmd.action(async (serviceId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const localCaps = buildLocalCapabilityMap(deps.program);

    let data: Record<string, unknown> | null = null;

    try {
      const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
        message: 'API Key:',
        type: 'password',
      });

      const result = await deps.discoveryClient.get<Record<string, unknown>>(
        `/api/discovery/v1/catalog/${encodeURIComponent(serviceId)}`,
        { type: 'api-key', key: apiKey },
      );

      if (!result.success) {
        throw CliError.fromApi(result, { auth: 'api-key' });
      }

      data = gateCapability(result.data, localCaps);
    } catch {
      // Fallback to local registry.
      const local = findService(serviceId);
      data = local ? gateCapability(local as unknown as Record<string, unknown>, localCaps) : null;
    }

    if (data === null) {
      throw new CliError(
        'SERVICE_NOT_FOUND',
        `Service '${serviceId}' is not available in this CLI. Run "services list" to see available services.`,
      );
    }

    const resolved = data;
    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: resolved,
      text: () => formatServiceGet(resolved),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

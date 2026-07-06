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
 * One entry of the service-layer `verbs_summary` (doc/architecture-upgrade/v1/
 * schema-standard.md §3.1): verb name + one-line description + read/write
 * `annotations`. Deliberately excludes flags/response/example/error_recovery —
 * that is capability-layer detail, fetched via `schema_ref.help_command` /
 * `schema_ref.schema_url`, never inlined here.
 */
interface VerbSummaryItem {
  verb: string;
  description: string;
  annotations?: Record<string, unknown>;
}

/**
 * Build `verbs_summary` from the (already noun/verb-gated) capability: verb
 * list + one-line description + annotations. Descriptions prefer the backend's
 * pre-truncated `verb_descriptions` map; when only the full schema is present
 * (e.g. local-registry fallback lacks `verb_descriptions` for some verb), fall
 * back to the capability layer's `description` field for that verb.
 */
function buildVerbsSummary(data: Record<string, unknown>): VerbSummaryItem[] {
  const verbs = Array.isArray(data.verbs) ? (data.verbs as string[]) : [];
  const verbDescriptions = (data.verb_descriptions as Record<string, string>) ?? {};
  const schema = data.schema_content as Record<string, unknown> | undefined;
  const schemaVerbs = schema?.verbs as Record<string, Record<string, unknown>> | undefined;

  return verbs.map((verb) => {
    const item: VerbSummaryItem = {
      verb,
      description: verbDescriptions[verb] ?? String(schemaVerbs?.[verb]?.description ?? ''),
    };
    const annotations = schemaVerbs?.[verb]?.annotations as Record<string, unknown> | undefined;
    if (annotations) item.annotations = annotations;
    return item;
  });
}

/**
 * Project a gated capability onto the **service layer** shape (doc/
 * architecture-upgrade/v1/schema-standard.md §3): identity fields +
 * `selection_hints` + `schema_ref` + `conventions` + the FULL `workflow`
 * object (`description`/`steps`/`branches`/`standalone`/`prerequisites` — not
 * the flattened verb-name array the discovery registry's top-level `workflow`
 * carries) + `verbs_summary` + `cross_service_recovery`.
 *
 * This is deliberately NOT the capability layer: per-verb `flags`/`response`/
 * `example`/`error_recovery` (the bulk of `schema_content`, tens of KB across
 * a dozen verbs) are never copied into this view. An Agent that needs that
 * detail follows `schema_ref.help_command` (`<noun> <verb> --help --format
 * json`) or `schema_ref.schema_url` — the two capability-layer entry points
 * the standard defines. `services get` does not add a third one.
 *
 * Degrades gracefully when `schema_content` is absent (the local-registry
 * fallback has no schema_content): `selection_hints` / `conventions` /
 * `cross_service_recovery` are simply omitted, and `workflow` falls back to a
 * description-only object built from the registry's flat verb-sequence array.
 */
function toServiceLayerView(data: Record<string, unknown>): Record<string, unknown> {
  const schema = data.schema_content as Record<string, unknown> | undefined;

  const view: Record<string, unknown> = {
    service_id: data.service_id,
    cli_noun: data.cli_noun,
    category: data.category,
    name: data.name,
    summary: data.description ?? schema?.summary,
    status: data.status ?? 'available',
    provider: data.provider,
    version: data.version,
  };

  if (schema?.selection_hints) view.selection_hints = schema.selection_hints;

  // schema_ref: the two capability-layer lookup paths. Prefer the schema's own
  // schema_ref; degrade to the discovery hints the registry always carries.
  const discovery = data.discovery as Record<string, unknown> | undefined;
  view.schema_ref = schema?.schema_ref ?? {
    help_command: discovery?.help_command,
    ...(discovery?.schema_url ? { schema_url: discovery.schema_url } : {}),
  };

  if (schema?.conventions) view.conventions = schema.conventions;

  if (schema?.workflow) {
    view.workflow = schema.workflow;
  } else if (Array.isArray(data.workflow)) {
    view.workflow = { description: (data.workflow as string[]).join(' → ') };
  }

  view.verbs_summary = buildVerbsSummary(data);

  if (schema?.cross_service_recovery) view.cross_service_recovery = schema.cross_service_recovery;

  return view;
}

/** Render the service-layer view as a key/value + nested-block table for `--format table`. */
function formatServiceGet(s: Record<string, unknown>): string {
  const lines: [string, string][] = [
    ['Service ID', String(s.service_id ?? '')],
    ['CLI Noun', String(s.cli_noun ?? '')],
    ['Category', String(s.category ?? '')],
    ['Name', String(s.name ?? '')],
    ['Summary', String(s.summary ?? '')],
    ['Status', String(s.status ?? '')],
    ['Provider', String(s.provider ?? '')],
    ['Version', String(s.version ?? '')],
  ];
  const block = Formatter.keyValue(lines);

  const sections: string[] = [];
  for (const key of [
    'selection_hints',
    'schema_ref',
    'conventions',
    'workflow',
    'verbs_summary',
    'cross_service_recovery',
  ]) {
    if (s[key] !== undefined) {
      sections.push(`${key}:\n${JSON.stringify(s[key], null, 2)}`);
    }
  }
  return sections.length > 0 ? `${block}\n\n${sections.join('\n\n')}` : block;
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
 * `services get <service-id>` — return the **service layer** view (doc/
 * architecture-upgrade/v1/schema-standard.md §3): enough for an Agent to
 * understand the service and plan the call sequence (`workflow`), WITHOUT the
 * full per-verb flags/response/example/error_recovery (the capability layer),
 * which stays behind `schema_ref.help_command` / `schema_ref.schema_url`.
 *
 * Primary path: `GET /api/discovery/v1/catalog/<service-id>` → full schema, then
 * gated against the CLI command tree (noun must exist; verbs intersected).
 * Fallback: local registry (no schema_content — service-layer view degrades
 * gracefully, see `toServiceLayerView`).
 */
export function registerServiceGetCommand(
  parent: Command,
  deps: { discoveryClient: ApiClient; program: Command },
): void {
  const cmd = parent
    .command('get <service-id>')
    .description('Retrieve a single merchant service (service-layer view: workflow + conventions + verbs_summary)')
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

    const resolved = toServiceLayerView(data);
    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: resolved,
      text: () => formatServiceGet(resolved),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import {
  attachSchemaHelp,
  rideCallbackSetSchema,
  rideCallbackGetSchema,
  rideCallbackDefaultSetSchema,
  rideCallbackDefaultGetSchema,
  rideCallbackDeliveriesSchema,
  rideCallbackReplaySchema,
} from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

/**
 * Ride status-callback commands — thin wrappers over the platform's callback routes:
 *
 *   callback-set          POST /ride/<order-id>/callback          (per-ride destination)
 *   callback-get          GET  /ride/<order-id>/callback
 *   callback-default-set  POST /ride/callback/default             (developer-wide fallback)
 *   callback-default-get  GET  /ride/callback/default
 *   callback-deliveries   GET  /ride/<order-id>/callback/deliveries
 *   callback-replay       POST /ride/<order-id>/callback/replay
 *
 * The platform enforces ownership (another developer's ride reads as not found) and the
 * https / non-internal URL rule (SSRF guard); the CLI only checks shape. The signing secret
 * comes back exactly once, in the set response that issued it — it is printed with a warning
 * and never retrievable again.
 */

const SIGNATURE_MODES = ['off', 'optional', 'required'] as const;
const DELIVERIES_LIMIT_MAX = 100;

function need(value: string | undefined, flag: string): string {
  if (value === undefined || String(value).trim() === '') {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return String(value);
}

function intFlag(value: string | undefined, flag: string, min: number, max?: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `>= ${min}` : `${min}-${max}`;
    throw new CliError('PARAM_INVALID', `--${flag} must be an integer ${range}.`);
  }
  return parsed;
}

async function apiKeyOf(opts: Record<string, unknown>): Promise<string> {
  return PromptEngine.resolveInput(opts.apiKey as string | undefined, {
    message: 'API Key:',
    type: 'password',
  });
}

/** Body shared by per-ride and default registration. Omitted flags are not sent (server keeps the stored value). */
function subscriptionBody(opts: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { callback_url: need(opts.callbackUrl as string | undefined, 'callback-url') };
  if (opts.adapter !== undefined) body.adapter = need(opts.adapter as string, 'adapter');
  if (opts.signatureMode !== undefined) {
    const mode = String(opts.signatureMode);
    if (!(SIGNATURE_MODES as readonly string[]).includes(mode)) {
      throw new CliError('PARAM_INVALID', `--signature-mode must be one of ${SIGNATURE_MODES.join(' / ')}.`);
    }
    body.signature_mode = mode;
  }
  if (opts.callbackApiKey !== undefined) body.callback_api_key = String(opts.callbackApiKey);
  if (opts.rotateSecret) body.rotate_secret = true;
  return body;
}

function formatSubscription(data: Record<string, unknown>): string {
  const lines: [string, string][] = [];
  for (const key of ['ride_id', 'order_id', 'developer_id', 'callback_url', 'adapter', 'signature_mode', 'status']) {
    if (data[key] !== undefined && data[key] !== null) lines.push([key, String(data[key])]);
  }
  const out = [Formatter.keyValue(lines)];
  if (typeof data.callback_secret === 'string' && data.callback_secret) {
    out.push('', Formatter.keyValue([['callback_secret', data.callback_secret]]));
    out.push('Save this signing secret now — it is shown only once and cannot be read back.');
  }
  return out.join('\n');
}

type Format = ReturnType<typeof resolveFormat>;

async function render<T>(data: T, text: () => string, format: Format): Promise<void> {
  const commandResult: CommandResult<T> = { data, text };
  await renderWithContext(commandResult, { format }, new ConfigManager());
}

function withSubscriptionFlags(cmd: Command): Command {
  return cmd
    .option('--callback-url <url>', 'https URL that receives ride status events (must not be an internal address)')
    .option('--adapter <name>', 'Outbound event shape (default techtanium_v1)')
    .option('--signature-mode <mode>', 'off / optional / required (default off)')
    .option('--callback-api-key <key>', 'API key the platform sends to your endpoint; omit to keep the stored one')
    .option('--rotate-secret', 'Issue a new HMAC signing secret (breaks verification with the old one)')
    .option('--idempotency-key <key>', 'Idempotency key forwarded verbatim as the Idempotency-Key header');
}

async function postSubscription(
  deps: { apiClient: ApiClient },
  cmd: Command,
  path: (opts: Record<string, unknown>) => string,
  commandPath: string,
  doneMessage: string,
): Promise<void> {
  const opts = cmd.optsWithGlobals();
  const format = resolveFormat(opts.format as string | undefined);
  const target = path(opts);
  const body = subscriptionBody(opts);
  const apiKey = await apiKeyOf(opts);
  const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
    yes: Boolean(opts.yes),
    commandPath,
  });
  const result = await deps.apiClient.post<Record<string, unknown>>(
    target,
    { type: 'api-key', key: apiKey },
    body,
    { 'Idempotency-Key': idempotencyKey },
  );
  if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
  notify(format, 'success', doneMessage);
  await render(result.data, () => formatSubscription(result.data), format);
}

async function getJson(
  deps: { apiClient: ApiClient },
  cmd: Command,
  path: (opts: Record<string, unknown>) => string,
  text: (data: Record<string, unknown>) => string,
  params?: (opts: Record<string, unknown>) => Record<string, string> | undefined,
): Promise<void> {
  const opts = cmd.optsWithGlobals();
  const format = resolveFormat(opts.format as string | undefined);
  const target = path(opts);
  const query = params?.(opts);
  const apiKey = await apiKeyOf(opts);
  const result = await deps.apiClient.get<Record<string, unknown>>(target, { type: 'api-key', key: apiKey }, query);
  if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
  await render(result.data, () => text(result.data), format);
}

const ridePath = (opts: Record<string, unknown>, suffix: string): string =>
  `/ride/${encodeURIComponent(need(opts.orderId as string | undefined, 'order-id'))}/callback${suffix}`;

export function registerRideCallbackCommands(parent: Command, deps: { apiClient: ApiClient }): void {
  // callback-set
  const set = withSubscriptionFlags(
    parent
      .command('callback-set')
      .description('Register (or update) where one ride\'s status events are forwarded')
      .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
      .option('--order-id <id>', 'The numeric ride_id returned by book'),
  );
  attachSchemaHelp(set, rideCallbackSetSchema);
  set.action(() =>
    postSubscription(deps, set, (o) => ridePath(o, ''), 'ride-elife callback-set', 'Ride callback registered'),
  );

  // callback-get
  const get = parent
    .command('callback-get')
    .description('Show one ride\'s callback registration (the signing secret is never returned)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'The numeric ride_id returned by book');
  attachSchemaHelp(get, rideCallbackGetSchema);
  get.action(() => getJson(deps, get, (o) => ridePath(o, ''), formatSubscription));

  // callback-default-set
  const defSet = withSubscriptionFlags(
    parent
      .command('callback-default-set')
      .description('Register (or update) the developer-wide fallback for rides without their own callback')
      .option('--api-key <key>', 'API Key for authentication (X-Api-Key)'),
  );
  attachSchemaHelp(defSet, rideCallbackDefaultSetSchema);
  defSet.action(() =>
    postSubscription(
      deps,
      defSet,
      () => '/ride/callback/default',
      'ride-elife callback-default-set',
      'Default ride callback registered',
    ),
  );

  // callback-default-get
  const defGet = parent
    .command('callback-default-get')
    .description('Show the developer-wide fallback callback (the signing secret is never returned)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');
  attachSchemaHelp(defGet, rideCallbackDefaultGetSchema);
  defGet.action(() => getJson(deps, defGet, () => '/ride/callback/default', formatSubscription));

  // callback-deliveries
  const deliveries = parent
    .command('callback-deliveries')
    .description('List one ride\'s callback forwarding records (pending / delivered / dead)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'The numeric ride_id returned by book')
    .option('--limit <n>', `Page size 1-${DELIVERIES_LIMIT_MAX} (default 50)`)
    .option('--offset <n>', 'Records to skip (default 0)');
  attachSchemaHelp(deliveries, rideCallbackDeliveriesSchema);
  deliveries.action(() =>
    getJson(
      deps,
      deliveries,
      (o) => ridePath(o, '/deliveries'),
      (data) => {
        const rows = (data.deliveries as Record<string, unknown>[] | undefined) ?? [];
        if (rows.length === 0) return Formatter.status('info', 'No callback deliveries');
        return Formatter.table(
          ['Event', 'Status', 'Attempts', 'Last error'],
          rows.map((r) => [
            String(r.event_id ?? '-'),
            String(r.status ?? '-'),
            String(r.attempts ?? '-'),
            String(r.last_error ?? '-'),
          ]),
        );
      },
      (o) => {
        const limit = intFlag(o.limit as string | undefined, 'limit', 1, DELIVERIES_LIMIT_MAX);
        const offset = intFlag(o.offset as string | undefined, 'offset', 0);
        const params: Record<string, string> = {};
        if (limit !== undefined) params.limit = String(limit);
        if (offset !== undefined) params.offset = String(offset);
        return Object.keys(params).length > 0 ? params : undefined;
      },
    ),
  );

  // callback-replay
  const replay = parent
    .command('callback-replay')
    .description('Requeue one ride\'s dead (or failed) callback records; delivered records are never re-sent')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'The numeric ride_id returned by book')
    .option('--event-id <id>', 'Requeue only this record (default: all dead records of the ride)')
    .option('--include-failed', 'Also requeue pending records that already failed at least once')
    .option('--reset-attempts', 'Reset the retry counter of requeued records')
    .option('--idempotency-key <key>', 'Idempotency key forwarded verbatim as the Idempotency-Key header');
  attachSchemaHelp(replay, rideCallbackReplaySchema);
  replay.action(async () => {
    const opts = replay.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const target = ridePath(opts, '/replay');
    const body: Record<string, unknown> = {};
    if (opts.eventId !== undefined) body.event_id = need(opts.eventId as string, 'event-id');
    if (opts.includeFailed) body.include_failed = true;
    if (opts.resetAttempts) body.reset_attempts = true;
    const apiKey = await apiKeyOf(opts);
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: Boolean(opts.yes),
      commandPath: 'ride-elife callback-replay',
    });
    const result = await deps.apiClient.post<Record<string, unknown>>(
      target,
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    notify(format, 'success', `Requeued ${String(result.data.requeued ?? 0)} callback record(s)`);
    await render(
      result.data,
      () => Formatter.keyValue([
        ['Ride ID', String(result.data.ride_id ?? '-')],
        ['Requeued', String(result.data.requeued ?? 0)],
      ]),
      format,
    );
  });
}

import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import { attachSchemaHelp, dataQuerySchema } from '../verb-schema.js';
import {
  type Deps,
  jsonObject,
  kv,
  need,
  render,
  resolveApiKey,
  verbatimIdempotencyKey,
} from './_helpers.js';

/**
 * `data-aisa query` — run one capability and return its data. Charged per call,
 * READ-ONLY: it fetches data and nothing else.
 *
 * `--idempotency-key` is OPTIONAL here (unlike the write verbs of the booking
 * groups): when it is absent the header is simply not sent and the request goes
 * out as usual — no prompt, no error, and the CLI never generates a key. That is
 * why this command deliberately uses neither the write-verb key resolver nor its
 * trimming normalizer, but `verbatimIdempotencyKey`: the value given must itself
 * match the format and is forwarded byte-for-byte (R36).
 */
export function registerDataQueryCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('query')
    .description(
      'Run one capability and return its data. Charged per call. READ-ONLY: it fetches data and nothing else.',
    )
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--operation-id <id>', 'Which capability to run — an operationId returned by search, verbatim')
    .option(
      '--params <json>',
      "The capability's parameters as a JSON object keyed by the parameter names from describe. Passed through as a whole; unknown keys are dropped.",
    )
    .option(
      '--idempotency-key <key>',
      'Optional de-duplication key (1-128 chars [A-Za-z0-9_-]) forwarded verbatim as the Idempotency-Key header; never auto-generated, and omitting it is fine',
    );
  attachSchemaHelp(cmd, dataQuerySchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const operationId = need(opts.operationId as string | undefined, 'operation-id');

    const body: Record<string, unknown> = { operation_id: operationId };
    // The parsed object goes into the body verbatim — never stringified and
    // never rewritten field by field.
    if (opts.params !== undefined) {
      body.params = jsonObject(opts.params as string, 'params');
    }

    let idempotencyKey: string | undefined;
    if (opts.idempotencyKey !== undefined) {
      // Validated as given, never trimmed/rewritten: a key that does not match
      // the format is PARAM_INVALID instead of being silently corrected.
      idempotencyKey = verbatimIdempotencyKey(opts.idempotencyKey as string, 'idempotency-key');
    }
    // Header only — the key never enters the request body.
    const extraHeaders = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;

    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const spinner = format === 'json' ? null : createSpinner('Fetching data...');
    const result = await deps.apiClient.post<Record<string, unknown>>(
      '/data/query',
      { type: 'api-key', key: apiKey },
      body,
      extraHeaders,
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => kv(d));
  });
}

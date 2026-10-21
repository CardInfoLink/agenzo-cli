import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  IdempotencyKeyRequiredError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { attachSchemaHelp, travellersDeleteSchema } from '../verb-schema.js';

interface DeleteTravellerResult {
  deleted: boolean;
  traveller_token: string;
}

/**
 * `travellers delete [traveller_token]` — delete one of the member's saved travellers.
 *
 * POST /travellers/<traveller_token>/delete with X-Api-Key; --member maps to ?member_id=
 * (required by Platform for API-key callers: a saved traveller always belongs to a member).
 * Someone else's token and a token that does not exist get the same error, so the CLI
 * cannot be used to probe whether a token exists. Mirrors `payment-methods disable`:
 * the id may be positional or `--id`, and `--idempotency-key` is mandatory under --yes.
 */
export function registerTravellersDeleteCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('delete [traveller_token]')
    .description('Delete a saved traveller')
    .option('--api-key <key>', 'API Key for authentication')
    .option(
      '--id <traveller_token>',
      'Saved traveller token to delete (alternative to the positional <traveller_token>, for programmatic callers that pass flags only)',
    )
    .option('--member <member_id>', 'Member who owns the saved traveller (required with an API key)')
    .option('--idempotency-key <key>', 'Idempotency key forwarded verbatim as the Idempotency-Key header');

  attachSchemaHelp(cmd, travellersDeleteSchema);

  cmd.action(async (tokenArg: string | undefined) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const travellerToken = await PromptEngine.resolveInput(tokenArg ?? (opts.id as string | undefined), {
      message: 'Saved traveller token:',
    });
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (opts.yes) {
        throw new IdempotencyKeyRequiredError('travellers delete');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const member = opts.member as string | undefined;
    const query = member ? `?member_id=${encodeURIComponent(member)}` : '';

    const result = await deps.apiClient.post<DeleteTravellerResult>(
      `/travellers/${encodeURIComponent(travellerToken)}/delete${query}`,
      { type: 'api-key', key: apiKey },
      undefined,
      { 'Idempotency-Key': idempotencyKey },
    );
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });

    const data = result.data;
    notify(format, 'success', `Saved traveller ${travellerToken} deleted`);

    const commandResult: CommandResult<DeleteTravellerResult> = {
      data,
      text: () => Formatter.keyValue([['Deleted', data.traveller_token]]),
    };
    await renderWithContext(commandResult, { format }, new ConfigManager());
  });
}

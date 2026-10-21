import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { attachSchemaHelp, travellersListSchema } from '../verb-schema.js';

/** A saved traveller as Platform returns it: token + masked values only, never the plain ID number. */
export interface SavedTraveller {
  traveller_token: string;
  surname: string;
  name: string;
  gender: string;
  birthday: string;
  nationality: string;
  id_type: string;
  id_number_masked: string;
  expiration: string;
}

/**
 * `travellers list` — the member's saved travellers.
 *
 * GET /travellers with X-Api-Key; --member maps to ?member_id=. Platform returns
 * `{travellers: [...]}`. Pass a traveller_token as a passenger to
 * `merchant flight-flink create-order` instead of the full details.
 */
export function registerTravellersListCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list')
    .description('List saved travellers (token + masked values only)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--member <member_id>', 'Member whose saved travellers to list');

  attachSchemaHelp(cmd, travellersListSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    const params: Record<string, string> = {};
    if (opts.member) params.member_id = opts.member as string;

    const result = await deps.apiClient.get<{ travellers: SavedTraveller[] }>(
      '/travellers',
      { type: 'api-key', key: apiKey },
      Object.keys(params).length > 0 ? params : undefined,
    );
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });

    const travellers = result.data?.travellers ?? [];
    const commandResult: CommandResult<{ travellers: SavedTraveller[] }> = {
      data: { travellers },
      text: () => {
        if (travellers.length === 0) return Formatter.status('info', 'No saved travellers');
        return Formatter.table(
          ['Token', 'Name', 'Birthday', 'ID', 'Expires'],
          travellers.map((t) => [
            t.traveller_token,
            `${t.surname}/${t.name}`,
            t.birthday || '-',
            t.id_number_masked || '-',
            t.expiration || '-',
          ]),
        );
      },
    };
    await renderWithContext(commandResult, { format }, new ConfigManager());
  });
}

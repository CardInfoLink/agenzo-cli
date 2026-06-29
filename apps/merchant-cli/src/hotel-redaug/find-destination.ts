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
import type { FindDestinationResponse } from '../types/hotel.js';
import { attachSchemaHelp, hotelFindDestinationSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (local — body assembly stays in app per req 15.3)
// ============================================================

/**
 * Require a non-empty flag value. Missing or empty input maps to
 * `PARAM_INVALID` before any request is issued.
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

// ============================================================
// Output helper (table formatter)
// ============================================================

/**
 * Render destinations as a table for `--format table`. An empty
 * `destinations[]` is a successful result (exit 0), not an error.
 */
function formatFindDestination(data: FindDestinationResponse): string {
  const destinations = data.destinations ?? [];
  if (destinations.length === 0) {
    return Formatter.status('info', 'No destinations found for this keyword');
  }

  const headers = ['Destination ID', 'Type', 'Name', 'City Name', 'City Code', 'Country', 'Lat', 'Lng'];
  const rows = destinations.map((d) => [
    String(d.destination_id ?? '-'),
    String(d.type ?? '-'),
    String(d.name ?? '-'),
    String(d.city_name ?? '-'),
    String(d.city_code ?? '-'),
    String(d.country_name ?? '-'),
    String(d.lat ?? '-'),
    String(d.lng ?? '-'),
  ]);

  return Formatter.table(headers, rows);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug find-destination` — search for a destination by keyword
 * (§ find-destination schema). Read-only (no idempotency key, no
 * confirmation).
 *
 * Validates `--keyword` is present and non-empty before any request
 * (→ `PARAM_INVALID`), POSTs to `/hotel/find-destination` with `X-Api-Key`
 * auth, and renders `FindDestinationResponse` via `renderWithContext`. An
 * empty `destinations[]` renders as a successful result (exit 0).
 */
export function registerHotelFindDestinationCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('find-destination')
    .description('Search for a hotel destination by keyword (city, landmark, airport, etc.)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--keyword <text>', 'Destination search keyword (required)')
    .option('--data-type <type>', 'Optional data type filter');

  attachSchemaHelp(cmd, hotelFindDestinationSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Validate BEFORE any request: --keyword required AND non-empty
    const keyword = need(opts.keyword as string | undefined, 'keyword');

    // Build request body (snake_case keys match platform contract).
    // Omit data_type when absent.
    const body: Record<string, unknown> = { keyword };
    if (opts.dataType !== undefined) {
      body.data_type = opts.dataType as string;
    }

    const result = await deps.apiClient.post<FindDestinationResponse>(
      '/hotel/find-destination',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<FindDestinationResponse> = {
      data,
      text: () => formatFindDestination(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

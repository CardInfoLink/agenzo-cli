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
import type { ListCitiesResponse } from '../types/hotel.js';
import { attachSchemaHelp, hotelListCitiesSchema } from '../verb-schema.js';

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
 * Render cities as a table for `--format table`. An empty `cities[]` is
 * a successful result (exit 0), not an error.
 */
function formatListCities(data: ListCitiesResponse): string {
  const cities = data.cities ?? [];
  if (cities.length === 0) {
    return Formatter.status('info', 'No cities found for this country');
  }

  const headers = ['City Code', 'City Name', 'Destination ID', 'Lat', 'Lng', 'Country', 'Time Zone'];
  const rows = cities.map((c) => [
    String(c.city_code ?? '-'),
    String(c.city_name ?? '-'),
    String(c.destination_id ?? '-'),
    String(c.lat ?? '-'),
    String(c.lng ?? '-'),
    String(c.country_name ?? '-'),
    String(c.time_zone ?? '-'),
  ]);

  return Formatter.table(headers, rows);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug list-cities` — list cities for a given country code
 * (§ list-cities schema). Read-only (no idempotency key, no confirmation).
 *
 * Validates `--country` is present and non-empty before any request
 * (→ `PARAM_INVALID`), POSTs to `/hotel/cities` with `X-Api-Key` auth,
 * and renders `ListCitiesResponse` via `renderWithContext`. An empty
 * `cities[]` renders as a successful result (exit 0).
 */
export function registerHotelListCitiesCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list-cities')
    .description('List cities available for hotel booking in a given country')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--country <code>', 'ISO country code (required)');

  attachSchemaHelp(cmd, hotelListCitiesSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Validate BEFORE any request: --country required AND non-empty
    const country = need(opts.country as string | undefined, 'country');

    // Build request body (snake_case keys match platform contract).
    // Flag is --country, body field is country_code.
    const body: Record<string, unknown> = { country_code: country };

    const result = await deps.apiClient.post<ListCitiesResponse>(
      '/hotel/cities',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<ListCitiesResponse> = {
      data,
      text: () => formatListCities(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

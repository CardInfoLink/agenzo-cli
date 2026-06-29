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
import type { HotelFiltersResponse, FacilityOption, FilterOption } from '../types/hotel.js';
import { attachSchemaHelp, hotelFiltersSchema } from '../verb-schema.js';

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

/** Number-ify a numeric flag. Non-finite input maps to `PARAM_INVALID`. */
function num(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isFinite(n)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return n;
}

/**
 * Number-ify a coordinate flag and enforce its valid range. Missing,
 * non-finite, or out-of-range input maps to `PARAM_INVALID` (requirement 20.2)
 * before any request is sent.
 */
function coord(value: string | undefined, flag: string, min: number, max: number): number {
  const n = num(value, flag);
  if (n < min || n > max) {
    throw new CliError('PARAM_INVALID', `--${flag} must be between ${min} and ${max}.`);
  }
  return n;
}

// ============================================================
// Output helper (table formatter)
// ============================================================

/**
 * Render a single filter group as a labelled section. Each item shows
 * code, name, and count (plus type for facility groups). The code values
 * map directly to the corresponding search filter flags.
 */
function renderGroup(title: string, items: FilterOption[], isFacility = false): string {
  if (items.length === 0) return '';

  const headers = isFacility
    ? ['Code', 'Name', 'Count', 'Type']
    : ['Code', 'Name', 'Count'];

  const rows = items.map((item) => {
    const base = [
      String(item.code ?? '-'),
      String(item.name ?? '-'),
      String(item.count ?? '-'),
    ];
    if (isFacility) {
      base.push(String((item as FacilityOption).type ?? '-'));
    }
    return base;
  });

  return `\n[${title}]\n${Formatter.table(headers, rows)}`;
}

/**
 * Render all hotel filter groups for `--format table`. Groups: stars, brands,
 * groups, labels, sub_categories, hotel_facilities, room_facilities. Each
 * item's code can be passed to the corresponding `search` filter flag.
 */
function formatFilters(data: HotelFiltersResponse): string {
  const sections = [
    renderGroup('Stars (→ search --star)', data.stars ?? []),
    renderGroup('Brands (→ search --hotel-brand-codes)', data.brands ?? []),
    renderGroup('Groups', data.groups ?? []),
    renderGroup('Labels (→ search --hotel-label-ids)', data.labels ?? []),
    renderGroup('Sub-Categories (→ search --hotel-sub-category-ids)', data.sub_categories ?? []),
    renderGroup('Hotel Facilities (→ search --hotel-facility-codes)', data.hotel_facilities ?? [], true),
    renderGroup('Room Facilities (→ search --room-facility-codes)', data.room_facilities ?? [], true),
  ].filter(Boolean);

  if (sections.length === 0) {
    return Formatter.status('info', 'No filter options available for this location');
  }

  return sections.join('\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug hotel-filters` — retrieve available filter options for a
 * location (§ hotel-filters schema). Read-only (no idempotency key, no
 * confirmation).
 *
 * Accepts exactly one location branch: `--destination-id` XOR (`--lat` AND
 * `--lng`). Supplying both branches or neither is `PARAM_INVALID` before any
 * request. The coordinate branch additionally validates lat∈[-90,90] and
 * lng∈[-180,180]. `--distance` (default 20) is always included in the body.
 *
 * The response groups filter options (stars, brands, groups, labels,
 * sub_categories, hotel_facilities, room_facilities) whose codes map directly
 * to the corresponding `search` filter flags.
 */
export function registerHotelFiltersCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('hotel-filters')
    .description('Get available filter options for hotel search at a given location (codes map to search filters)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--destination-id <id>', 'Destination ID (alternative to --lat/--lng)')
    .option('--lat <lat>', 'Latitude (-90 to 90, requires --lng)')
    .option('--lng <lng>', 'Longitude (-180 to 180, requires --lat)')
    .option('--distance <km>', 'Search radius in kilometers', '20');

  attachSchemaHelp(cmd, hotelFiltersSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // ---- Location branch validation (BEFORE any request) ----
    // Exactly one branch must be supplied:
    //   Branch A: --destination-id (alone)
    //   Branch B: --lat AND --lng (both required together)
    // Both branches OR neither → PARAM_INVALID.
    const hasDestination = opts.destinationId !== undefined;
    const hasLat = opts.lat !== undefined;
    const hasLng = opts.lng !== undefined;
    const hasCoordBranch = hasLat || hasLng;

    if (hasDestination && hasCoordBranch) {
      throw new CliError(
        'PARAM_INVALID',
        'Supply either --destination-id OR --lat/--lng, not both.',
      );
    }

    if (!hasDestination && !hasCoordBranch) {
      throw new CliError(
        'PARAM_INVALID',
        'Supply either --destination-id OR --lat/--lng (one location branch is required).',
      );
    }

    // Coordinate branch: both lat AND lng must be present, with valid ranges.
    if (hasCoordBranch && !(hasLat && hasLng)) {
      throw new CliError(
        'PARAM_INVALID',
        '--lat and --lng must both be provided together.',
      );
    }

    // Build request body (snake_case keys match platform contract).
    const body: Record<string, unknown> = {};

    if (hasDestination) {
      body.destination_id = need(opts.destinationId as string | undefined, 'destination-id');
    } else {
      body.lat = coord(opts.lat as string | undefined, 'lat', -90, 90);
      body.lng = coord(opts.lng as string | undefined, 'lng', -180, 180);
    }

    // --distance always included (default 20)
    body.distance = num(opts.distance as string | undefined, 'distance');

    const result = await deps.apiClient.post<HotelFiltersResponse>(
      '/hotel/filters',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<HotelFiltersResponse> = {
      data,
      text: () => formatFilters(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

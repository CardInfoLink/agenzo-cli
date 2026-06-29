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
import type { SearchHotelResponse } from '../types/hotel.js';
import { attachSchemaHelp, hotelSearchSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/quote.ts and book.ts each define
// their own need/num) rather than pulled from a shared helpers file.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 2.3 / design §4.4) — a catalog code (exit 1), mirroring the
 * `ride-elife` convention; `PARAM_REQUIRED` is intentionally not used (it is
 * not in the cli-core error catalog).
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
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
 * non-finite, or out-of-range input maps to `PARAM_INVALID` (requirement 2.4)
 * before any request is sent. Coordinates are sent as numbers, never strings.
 */
function coord(value: string | undefined, flag: string, min: number, max: number): number {
  const n = num(value, flag);
  if (n < min || n > max) {
    throw new CliError('PARAM_INVALID', `--${flag} must be between ${min} and ${max}.`);
  }
  return n;
}

/**
 * Validate a supplied flag as a positive integer. `undefined` is allowed
 * (caller decides whether the flag is required). Non-finite or ≤ 0 → `PARAM_INVALID`.
 */
function positiveInt(value: string | undefined, flag: string): number {
  const n = num(value, flag);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a positive integer.`);
  }
  return n;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Require and validate a stay date. The value must be a real `YYYY-MM-DD`
 * calendar date (e.g. `2026-02-30` is rejected); otherwise `PARAM_INVALID`
 * (requirement 2.5) before any request is sent. Returns the canonical string.
 */
function stayDate(value: string | undefined, flag: string): string {
  const raw = need(value, flag);
  if (!YMD_RE.test(raw)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a YYYY-MM-DD date.`);
  }
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a valid calendar date (YYYY-MM-DD).`);
  }
  return raw;
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render the search hits as a table for `--format table`. Each hotel is one
 * row; the indicative `lowest_price.amount` is a decimal currency unit (NOT
 * cents) — printed verbatim. An empty `hotels` list is a successful result, so
 * it renders an info line (never an error).
 *
 * Extended fields from enriched HotelSummary (city_name, score, main_image) are
 * included when present.
 */
function formatSearch(data: SearchHotelResponse): string {
  const hotels = data.hotels ?? [];
  if (hotels.length === 0) {
    return Formatter.status('info', 'No hotels found for this area and dates');
  }

  const headers = ['Hotel ID', 'Name', 'Star', 'Distance (km)', 'From', 'Currency', 'City', 'Score', 'Image', 'Address'];
  const rows = hotels.map((h) => [
    String(h.hotel_id ?? '-'),
    String(h.hotel_name ?? '-'),
    String(h.star ?? '-'),
    String(h.distance_km ?? '-'),
    String(h.lowest_price?.amount ?? '-'),
    String(h.lowest_price?.currency ?? '-'),
    String(h.city_name ?? '-'),
    String(h.score ?? '-'),
    String(h.main_image ?? '-'),
    String(h.address ?? '-'),
  ]);

  return Formatter.table(headers, rows);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug search` — search hotels near a coordinate or within a
 * destination for a stay (§ search schema). Read-only (no idempotency key).
 *
 * Accepts exactly one location branch:
 *   Branch A: --destination-id (alone, no lat/lng needed)
 *   Branch B: --lat AND --lng (both required together)
 * Supplying both branches or neither → PARAM_INVALID before any request.
 *
 * Builds the `/hotel/search` body from flags (coordinates number-ified and
 * range-checked when coordinate branch, dates validated as `YYYY-MM-DD` with
 * `check-out` strictly after `check-in`, all before any request → `PARAM_INVALID`),
 * POSTs with the `X-Api-Key` auth, and renders `SearchHotelResponse` via
 * `renderWithContext` (json carries the profile/endpoint envelope). An empty
 * `hotels` list renders as a successful result (exit 0), not an error.
 */
export function registerHotelSearchCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('search')
    .description('Search hotels near a coordinate or within a destination for the given stay dates')
    // Location branch A: destination-id
    .option('--destination-id <id>', 'Destination ID (alternative to --lat/--lng)')
    // Location branch B: lat/lng
    .option('--lat <lat>', 'Latitude of the search center (-90 to 90)')
    .option('--lng <lng>', 'Longitude of the search center (-180 to 180)')
    // Common location/search params
    .option('--distance <km>', 'Search radius in kilometers', '20')
    .option('--check-in <date>', 'Check-in date (YYYY-MM-DD)')
    .option('--check-out <date>', 'Check-out date (YYYY-MM-DD, strictly after check-in)')
    .option('--adults <n>', 'Number of adults', '2')
    .option('--children <n>', 'Number of children', '0')
    .option('--room-num <n>', 'Number of rooms requested', '1')
    .option('--star <n>', 'Minimum hotel star rating filter (3/4/5)')
    .option('--keyword <text>', 'Optional hotel name keyword to narrow results')
    // Filter flags (each forwarded only when supplied)
    .option('--price-min <n>', 'Minimum price filter')
    .option('--price-max <n>', 'Maximum price filter')
    .option('--sort-by <field>', 'Sort field')
    .option('--page <n>', 'Page number (positive integer)', '1')
    .option('--page-size <n>', 'Results per page (positive integer)', '10')
    .option('--hotel-facility-codes <codes>', 'Hotel facility codes (comma-separated or JSON array)')
    .option('--room-facility-codes <codes>', 'Room facility codes (comma-separated or JSON array)')
    .option('--hotel-brand-codes <codes>', 'Hotel brand codes (comma-separated or JSON array)')
    .option('--plate-codes <codes>', 'Plate codes (comma-separated or JSON array)')
    .option('--hotel-label-ids <ids>', 'Hotel label IDs (comma-separated or JSON array)')
    .option('--hotel-sub-category-ids <ids>', 'Hotel sub-category IDs (comma-separated or JSON array)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');

  attachSchemaHelp(cmd, hotelSearchSchema);

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

    // ---- Date validation (common to both branches) ----
    const checkIn = stayDate(opts.checkIn as string | undefined, 'check-in');
    const checkOut = stayDate(opts.checkOut as string | undefined, 'check-out');
    // Both are validated YYYY-MM-DD, so a lexical compare is a correct date
    // order; check-out must be strictly after check-in.
    if (!(checkOut > checkIn)) {
      throw new CliError('PARAM_INVALID', '--check-out must be strictly after --check-in.');
    }

    // ---- Pagination validation (BEFORE any request) ----
    const page = positiveInt(opts.page as string | undefined, 'page');
    const pageSize = positiveInt(opts.pageSize as string | undefined, 'page-size');

    // ---- Build request body ----
    // Location branch: destination_id OR (lat, lng)
    const body: Record<string, unknown> = {};

    if (hasDestination) {
      body.destination_id = need(opts.destinationId as string | undefined, 'destination-id');
    } else {
      body.lat = coord(opts.lat as string | undefined, 'lat', -90, 90);
      body.lng = coord(opts.lng as string | undefined, 'lng', -180, 180);
    }

    // Common fields
    body.distance = num(opts.distance as string | undefined, 'distance');
    body.check_in = checkIn;
    body.check_out = checkOut;
    body.adults = num(opts.adults as string | undefined, 'adults');
    body.children = num(opts.children as string | undefined, 'children');
    body.room_num = num(opts.roomNum as string | undefined, 'room-num');

    // Optional filters — included only when supplied (omitted keys never enter
    // the body). --star is numeric when present; --keyword is free text.
    if (opts.star !== undefined) body.star = num(opts.star as string, 'star');
    if (opts.keyword !== undefined) body.keyword = opts.keyword as string;

    // Price filters (numeric when present)
    if (opts.priceMin !== undefined) body.price_min = num(opts.priceMin as string, 'price-min');
    if (opts.priceMax !== undefined) body.price_max = num(opts.priceMax as string, 'price-max');

    // Sort
    if (opts.sortBy !== undefined) body.sort_by = opts.sortBy as string;

    // Pagination (always included — has defaults)
    body.page = page;
    body.page_size = pageSize;

    // Opaque code array filters — forwarded as-is when supplied
    if (opts.hotelFacilityCodes !== undefined) body.hotel_facility_codes = opts.hotelFacilityCodes as string;
    if (opts.roomFacilityCodes !== undefined) body.room_facility_codes = opts.roomFacilityCodes as string;
    if (opts.hotelBrandCodes !== undefined) body.hotel_brand_codes = opts.hotelBrandCodes as string;
    if (opts.plateCodes !== undefined) body.plate_codes = opts.plateCodes as string;
    if (opts.hotelLabelIds !== undefined) body.hotel_label_ids = opts.hotelLabelIds as string;
    if (opts.hotelSubCategoryIds !== undefined) body.hotel_sub_category_ids = opts.hotelSubCategoryIds as string;

    const result = await deps.apiClient.post<SearchHotelResponse>(
      '/hotel/search',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<SearchHotelResponse> = {
      data,
      text: () => formatSearch(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

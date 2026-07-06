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
import type { HotelDetailResponse } from '../types/hotel.js';
import { attachSchemaHelp, hotelDetailSchema } from '../verb-schema.js';

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
// Output helpers (table formatter)
// ============================================================

/**
 * Render hotel detail as a key/value block + facilities table + images table.
 * Images table is empty when `--with-images false`.
 */
function formatHotelDetail(data: HotelDetailResponse): string {
  const lines: string[] = [];

  // Key/value block
  const kvPairs: [string, string][] = [
    ['Hotel ID', String(data.hotel_id ?? '-')],
    ['Hotel Name', String(data.hotel_name ?? '-')],
    ['English Name', String(data.hotel_eng_name ?? '-')],
    ['Star', String(data.star ?? '-')],
    ['Address', String(data.address ?? '-')],
    ['Intro', String(data.intro ?? '-')],
    ['Telephone', String(data.telephone ?? '-')],
    ['Country', String(data.country_name ?? '-')],
    ['Province', String(data.province_name ?? '-')],
    ['City', String(data.city_name ?? '-')],
    ['District', String(data.district_name ?? '-')],
    ['Business Area', String(data.business_name ?? '-')],
    ['Latitude', String(data.lat ?? '-')],
    ['Longitude', String(data.lng ?? '-')],
    ['Check-in Time', String(data.check_in_time ?? '-')],
    ['Check-out Time', String(data.check_out_time ?? '-')],
    ['Room Count', String(data.room_num ?? '-')],
  ];

  lines.push(Formatter.keyValue(kvPairs));

  // Facilities table
  const facilities = data.facilities ?? [];
  if (facilities.length > 0) {
    lines.push('');
    lines.push('Facilities:');
    const facHeaders = ['Name', 'Type'];
    const facRows = facilities.map((f) => [
      String(f.name ?? '-'),
      String(f.type ?? '-'),
    ]);
    lines.push(Formatter.table(facHeaders, facRows));
  } else {
    lines.push('');
    lines.push(Formatter.status('info', 'No facilities listed'));
  }

  // Images table
  const images = data.images ?? [];
  if (images.length > 0) {
    lines.push('');
    lines.push('Images:');
    const imgHeaders = ['URL', 'Is Main'];
    const imgRows = images.map((img) => [
      String(img.url ?? '-'),
      String(img.is_main ?? false),
    ]);
    lines.push(Formatter.table(imgHeaders, imgRows));
  } else {
    lines.push('');
    lines.push(Formatter.status('info', 'No images available'));
  }

  // Rooms table — static room-type info (area/floor/beds/occupancy) + a
  // per-room image count. room_id is the SAME id space as quote's
  // roomItems[].roomId, so this can be related to quote's live rates.
  const rooms = data.rooms ?? [];
  if (rooms.length > 0) {
    lines.push('');
    lines.push('Rooms:');
    const roomHeaders = ['Room ID', 'Room Name', 'Area', 'Floor', 'Max Person', 'Beds', 'Images'];
    const roomRows = rooms.map((r) => {
      const bedsStr = (r.beds ?? [])
        .map((b) => `${b.name ?? '-'}${b.num ? ` x${b.num}` : ''}`)
        .join(', ') || '-';
      return [
        String(r.room_id ?? '-'),
        String(r.room_name ?? '-'),
        String(r.area_sqm ?? '-'),
        String(r.floor ?? '-'),
        String(r.max_person ?? '-'),
        bedsStr,
        String((r.images ?? []).length),
      ];
    });
    lines.push(Formatter.table(roomHeaders, roomRows));
    lines.push(
      '',
      Formatter.status(
        'info',
        'room_id matches quote\'s roomItems[].roomId — use it to relate a room here to its live rate in quote.',
      ),
    );
  } else {
    lines.push('');
    lines.push(Formatter.status('info', 'No room-type details available'));
  }

  return lines.join('\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug hotel-detail` — get detailed information about a specific hotel
 * (§ hotel-detail schema). Read-only (no idempotency key, no confirmation).
 *
 * Validates `--hotel-id` is present and non-empty before any request
 * (→ `PARAM_INVALID`), POSTs to `/hotel/detail` with `X-Api-Key` auth,
 * and renders `HotelDetailResponse` via `renderWithContext`. When
 * `--with-images false`, the body sends `with_images: false` and the
 * platform returns an empty `images[]`.
 */
export function registerHotelDetailCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('hotel-detail')
    .description('Get detailed information about a specific hotel (facilities, images, etc.)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--hotel-id <id>', 'Hotel ID (required)')
    .option('--with-images [value]', 'Include hotel images (default: true)', true);

  attachSchemaHelp(cmd, hotelDetailSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Validate BEFORE any request: --hotel-id required AND non-empty
    const hotelId = need(opts.hotelId as string | undefined, 'hotel-id');

    // Resolve --with-images boolean. Commander parses boolean-like options:
    // --with-images / --with-images true → true (default)
    // --with-images false → 'false' (string)
    const rawWithImages = opts.withImages;
    const withImages = rawWithImages !== 'false' && rawWithImages !== false;

    // Build request body (snake_case keys match platform contract).
    const body: Record<string, unknown> = {
      hotel_id: hotelId,
      with_images: withImages,
    };

    const result = await deps.apiClient.post<HotelDetailResponse>(
      '/hotel/detail',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<HotelDetailResponse> = {
      data,
      text: () => formatHotelDetail(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

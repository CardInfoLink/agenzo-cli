import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  createSpinner,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { TripStatusResponse } from '../types/api.js';
import { attachSchemaHelp, rideTripStatusSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (ride-domain — stays in app per req 4.4)
// ============================================================

/** Missing required input maps to `PARAM_INVALID` (catalog code, exit 1). */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/** Leg index is 1-based; 0 or negative is a client-side `PARAM_INVALID`. */
function tripNo(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError('PARAM_INVALID', '--trip-no must be an integer >= 1.');
  }
  return parsed;
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render one leg's status. Location points are summarised (count + latest
 * sample) rather than dumped — a long ride can carry hundreds of points, and
 * `--format json` is the right channel for the full array.
 */
function formatTripStatus(data: TripStatusResponse): string {
  const lines: [string, string][] = [
    ['Ride ID', String(data.ride_id ?? '-')],
    ['Trip no', String(data.trip_no ?? '-')],
    ['Status', String(data.status ?? '-')],
  ];
  const points = data.points ?? [];
  lines.push(['Location points', String(points.length)]);
  const latest = points[points.length - 1];
  if (latest) {
    lines.push(['Latest position', `${latest.lat}, ${latest.lng} @ ${latest.utc_timestamp}`]);
  }
  return Formatter.keyValue(lines);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `ride-elife trip-status` — status of ONE leg of a multi-leg ride. Read-only
 * (no idempotency key).
 *
 * `GET /ride/<order-id>/trips/<trip-no>`. Single-shot only: whole-ride polling
 * belongs to `ride-elife get --watch`, and duplicating a watch loop here would
 * give two competing pollers for the same ride.
 */
export function registerRideTripStatusCommand(
  parent: Command,
  deps: { apiClient: ApiClient },
): void {
  const cmd = parent
    .command('trip-status')
    .description('Retrieve the status and driver location points of one leg of a ride')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Ride order id (the ride_id returned by `ride-elife book`)')
    .option('--trip-no <no>', '1-based leg index (default 1)');

  attachSchemaHelp(cmd, rideTripStatusSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });
    const orderId = need(opts.orderId as string | undefined, 'order-id');
    const leg = tripNo(opts.tripNo as string | undefined);

    const spinner = format === 'json' ? null : createSpinner('Fetching trip status...');

    const result = await deps.apiClient.get<TripStatusResponse>(
      `/ride/${encodeURIComponent(orderId)}/trips/${leg}`,
      { type: 'api-key', key: apiKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<TripStatusResponse> = {
      data,
      text: () => formatTripStatus(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

import { Command } from 'commander';
import { CliError, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { SearchFlightResponse } from '../types/flight.js';
import { attachSchemaHelp, flightSearchSchema } from '../verb-schema.js';
import { type Deps, jsonArray, need, num, render, resolveApiKey } from './_helpers.js';

/** `flight-flink search` — search flights (one-way/round-trip/multi-city, journeyId relay). */
export function registerSearchCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('search')
    .description('Search flights (one-way/round-trip/multi-city, journeyId relay)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--trip-type <n>', '1=one-way, 2=round-trip, 3=multi-city')
    .option('--journeys <json>', 'JSON array of {date, origin, destination, origin_type?, destination_type?}')
    .option('--cabin-class <c>', 'economy | premium_economy | business | first', 'economy')
    .option('--adult-num <n>', 'Adults (1-9)', '1')
    .option('--child-num <n>', 'Children (0-9)', '0')
    .option('--infant-num <n>', 'Infants (0-9)', '0')
    .option('--airline <code>', 'Airline 2-letter code filter')
    .option('--transfer-number <n>', '0=any,1=direct,2=1 stop,3=2 stops', '0')
    .option('--journey-id <json>', 'JSON array of already-selected journey ids (relay)');
  attachSchemaHelp(cmd, flightSearchSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);

    const body: Record<string, unknown> = {
      trip_type: num(opts.tripType as string | undefined, 'trip-type'),
      journeys: jsonArray(need(opts.journeys as string | undefined, 'journeys'), 'journeys'),
      cabin_class: opts.cabinClass as string,
      adult_num: num(opts.adultNum as string | undefined, 'adult-num'),
      child_num: num(opts.childNum as string | undefined, 'child-num'),
      infant_num: num(opts.infantNum as string | undefined, 'infant-num'),
      transfer_number: num(opts.transferNumber as string | undefined, 'transfer-number'),
    };
    if (opts.airline !== undefined) body.airline = opts.airline as string;
    if (opts.journeyId !== undefined) {
      body.journey_id = jsonArray(opts.journeyId as string, 'journey-id');
    }

    const spinner = format === 'json' ? null : createSpinner('Searching flights...');
    const result = await deps.apiClient.post<SearchFlightResponse>(
      '/flight/search',
      { type: 'api-key', key: apiKey },
      body,
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) => JSON.stringify(d, null, 2));
  });
}

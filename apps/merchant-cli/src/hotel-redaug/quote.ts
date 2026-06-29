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
import type { QuoteHotelResponse, HotelRate, PriceItem } from '../types/hotel.js';
import { attachSchemaHelp, hotelQuoteSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/quote.ts and hotel-redaug/search.ts
// each define their own need/num/stayDate) rather than pulled from a shared
// helpers file. `quote` is read-only — no idempotency key.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 3.3 / design §4.4) — a catalog code (exit 1), mirroring the
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

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Require and validate a stay date. The value must be a real `YYYY-MM-DD`
 * calendar date (e.g. `2026-02-30` is rejected); otherwise `PARAM_INVALID`
 * (requirement 3.4) before any request is sent. Returns the canonical string.
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
 * Compact per-night summary of a rate's `price_items`. Each night is
 * `<date>: <sale_price> (bf <n>)`; `sale_price` is a DECIMAL currency amount
 * (NOT cents) — printed verbatim. An empty breakdown renders as `-`.
 */
function summarizePriceItems(items: PriceItem[] | undefined): string {
  if (!items || items.length === 0) return '-';
  return items
    .map((it) => `${it.sale_date}: ${it.sale_price} (bf ${it.breakfast_num})`)
    .join('; ');
}

/**
 * Render the bookable rates as a table for `--format table`. Each rate is one
 * row carrying the opaque `product_token` (printed verbatim — passed to `book`
 * unchanged), room name, the whole-stay `total_price.amount`+`currency` (DECIMAL
 * units, NOT cents — printed verbatim), and a per-night `price_items` summary.
 * An empty `rates` list is a successful result, so it renders an info line
 * (never an error).
 */
function formatQuote(data: QuoteHotelResponse): string {
  const rates: HotelRate[] = data.rates ?? [];
  if (rates.length === 0) {
    return Formatter.status('info', 'No bookable rates for this hotel and dates');
  }

  const headers = ['Product Token', 'Room', 'Total', 'Currency', 'Per-night (price_items)'];
  const rows = rates.map((r) => [
    String(r.product_token ?? '-'),
    String(r.room_name ?? '-'),
    String(r.total_price?.amount ?? '-'),
    String(r.total_price?.currency ?? '-'),
    summarizePriceItems(r.price_items),
  ]);

  return Formatter.table(headers, rows);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug quote` — get real-time room types and bookable rates for one
 * hotel and stay (§ quote schema). Read-only (no idempotency key).
 *
 * Builds the `/hotel/quote` body from flags (`--hotel-id` required, dates
 * validated as `YYYY-MM-DD` with `check-out` strictly after `check-in`, numeric
 * guest/room flags finite — all before any request → `PARAM_INVALID`), POSTs
 * with the `X-Api-Key` auth, and renders `QuoteHotelResponse` via
 * `renderWithContext` (json carries the profile/endpoint envelope). Each rate's
 * `product_token`, `total_price.amount`/`currency` and `price_items` are decimal
 * units rendered verbatim. An empty `rates` list renders as a successful result
 * (exit 0), not an error.
 */
export function registerHotelQuoteCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('quote')
    .description('Get real-time room types and bookable rates for one hotel and stay')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--hotel-id <id>', 'Hotel chosen from search results (hotels[].hotel_id)')
    .option('--check-in <date>', 'Check-in date (YYYY-MM-DD, match search)')
    .option('--check-out <date>', 'Check-out date (YYYY-MM-DD, strictly after check-in)')
    .option('--adults <n>', 'Number of adults per room', '2')
    .option('--children <n>', 'Number of children per room', '0')
    .option('--room-num <n>', 'Number of rooms requested', '1')
    .option('--nationality <code>', 'Guest nationality (ISO country code)', 'CN');

  attachSchemaHelp(cmd, hotelQuoteSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build request body. All validation throws PARAM_INVALID BEFORE any
    // request: --hotel-id required; dates real YYYY-MM-DD with check-out
    // strictly after check-in; the numeric guest/room flags finite. snake_case
    // keys match the platform contract.
    const hotelId = need(opts.hotelId as string | undefined, 'hotel-id');

    const checkIn = stayDate(opts.checkIn as string | undefined, 'check-in');
    const checkOut = stayDate(opts.checkOut as string | undefined, 'check-out');
    // Both are validated YYYY-MM-DD, so a lexical compare is a correct date
    // order; check-out must be strictly after check-in.
    if (!(checkOut > checkIn)) {
      throw new CliError('PARAM_INVALID', '--check-out must be strictly after --check-in.');
    }

    const body: Record<string, unknown> = {
      hotel_id: hotelId,
      check_in: checkIn,
      check_out: checkOut,
      adults: num(opts.adults as string | undefined, 'adults'),
      children: num(opts.children as string | undefined, 'children'),
      room_num: num(opts.roomNum as string | undefined, 'room-num'),
      nationality: opts.nationality as string,
    };

    const result = await deps.apiClient.post<QuoteHotelResponse>(
      '/hotel/quote',
      { type: 'api-key', key: apiKey },
      body,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<QuoteHotelResponse> = {
      data,
      text: () => formatQuote(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

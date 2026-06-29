import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
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
import type { BookHotelResponse, PriceItem } from '../types/hotel.js';
import { attachSchemaHelp, hotelBookSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/book.ts and hotel-redaug/search.ts
// /quote.ts each define their own need/num/stayDate) rather than pulled from a
// shared helpers file.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 4.3 / design §4.4) — a catalog code (exit 1), mirroring the
 * `ride-elife` convention; `PARAM_REQUIRED` is intentionally not used (it is
 * not in the cli-core error catalog).
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

/**
 * Number-ify a numeric flag. Non-finite input maps to `PARAM_INVALID`. The
 * value is forwarded verbatim as a decimal currency unit (NEVER minor units)
 * for `--total-amount` (requirement 4.4).
 */
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
 * (requirement 4.3) before any request is sent. Returns the canonical string.
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
// Structured-flag parser (pure builder — directly property-testable)
// ============================================================

/**
 * Parse and shape-validate `--price-items` (requirement 4.5, design Property 3).
 *
 * The raw flag MUST be a JSON array in which every element carries `sale_date`
 * (string), `sale_price` (number), and `breakfast_num` (number). Any deviation
 * — non-JSON, a non-array, or any element missing/mistyping a required field —
 * raises `PARAM_INVALID` before any request is issued.
 *
 * The parsed array is returned VERBATIM (the actual parsed objects, extra keys
 * untouched) and forwarded as-is in the request body: `sale_price` is a DECIMAL
 * currency amount and is never converted to/from minor units (requirement 4.4).
 *
 * Exported so the task-6 property suite can import and exercise it directly.
 */
export function parsePriceItems(raw: string): PriceItem[] {
  const INVALID =
    '--price-items must be a JSON array of {sale_date (string), sale_price (number), breakfast_num (number)}.';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('PARAM_INVALID', INVALID);
  }

  if (!Array.isArray(parsed)) {
    throw new CliError('PARAM_INVALID', INVALID);
  }

  for (const el of parsed) {
    if (typeof el !== 'object' || el === null || Array.isArray(el)) {
      throw new CliError('PARAM_INVALID', INVALID);
    }
    const item = el as Record<string, unknown>;
    if (
      typeof item.sale_date !== 'string' ||
      typeof item.sale_price !== 'number' ||
      typeof item.breakfast_num !== 'number'
    ) {
      throw new CliError('PARAM_INVALID', INVALID);
    }
  }

  // Forwarded verbatim — the parsed objects are returned unchanged.
  return parsed as PriceItem[];
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render a booked hotel order as a key/value block plus a rooms table for
 * `--format table`. Amounts are decimal currency units (NOT cents) — printed
 * verbatim. A closing info line conveys the async-confirmation contract
 * (requirement 4.8): an `order_status` of `PROCESSING` means the booking is
 * still processing and the Agent must poll `get` until `CONFIRMED`.
 */
function formatBook(data: BookHotelResponse): string {
  const lines: [string, string][] = [
    ['Order ID', String(data.order_id ?? '-')],
    ['FC order code', String(data.fc_order_code ?? '-')],
    ['Order status', String(data.order_status ?? '-')],
  ];
  if (data.pay_status) lines.push(['Pay status', String(data.pay_status)]);
  if (data.price) lines.push(['Price', `${data.price.amount} ${data.price.currency}`]);
  if (data.payment_status) lines.push(['Payment status', String(data.payment_status)]);
  if (data.provider) lines.push(['Provider', String(data.provider)]);
  if (data.billing_entry_id) lines.push(['Billing entry', String(data.billing_entry_id)]);

  const out: string[] = [Formatter.keyValue(lines)];

  const rooms = data.rooms ?? [];
  if (rooms.length > 0) {
    const headers = ['Room index', 'Guest name'];
    const rows = rooms.map((r) => [String(r.room_index ?? '-'), String(r.guest_name ?? '-')]);
    out.push('', Formatter.table(headers, rows));
  }

  out.push(
    '',
    Formatter.status(
      'info',
      `order_status PROCESSING means the booking is still processing — poll 'hotel-redaug get --order-id ${data.order_id ?? '<order_id>'}' until order_status=CONFIRMED.`,
    ),
  );

  return out.join('\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug book` — create and pay for a hotel booking in one step against
 * a recent `quote` (§ book schema). Write op (W/Y) — monthly_settlement only.
 *
 * Funding is decided server-side by the developer's settlement account; the
 * merchant domain never holds a payment credential, so the request body carries
 * NO payment handle. A non-empty `--payment-order-id` is a billing-mode mismatch
 * rejected with `BILLING_MODE_MISMATCH` BEFORE any request (design Property 7);
 * the value never enters the body.
 *
 * `POST /hotel/book` with `X-Api-Key` auth + the resolved `Idempotency-Key`
 * header (key forwarded verbatim, never in the body). All flag validation —
 * required fields, real `YYYY-MM-DD` dates with `check-out` strictly after
 * `check-in`, finite `--total-amount`, and the `--price-items` JSON shape —
 * raises `PARAM_INVALID` before any request is sent. `--yes` skips the confirm;
 * a declined confirm maps to `CLIENT_ABORTED`; a missing `--idempotency-key`
 * under `--yes` throws `PARAM_IDEMPOTENCY_KEY_REQUIRED` before any request.
 * Renders `BookHotelResponse` via `renderWithContext` (json carries the
 * profile/endpoint envelope); the progress spinner goes to stderr and stays
 * silent in json mode.
 */
export function registerHotelBookCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('book')
    .description('Create and pay for a hotel booking in one step using a recent quote')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--product-token <token>', 'Chosen rate token from quote (rates[].product_token)')
    .option('--total-amount <amount>', 'Total stay price in decimal currency units (not cents)')
    .option('--currency <currency>', 'ISO 4217 currency code from the chosen rate')
    .option('--price-items <json>', 'Per-night price breakdown JSON array (copied verbatim from quote)')
    .option('--check-in <date>', 'Check-in date (YYYY-MM-DD, match quote)')
    .option('--check-out <date>', 'Check-out date (YYYY-MM-DD, strictly after check-in)')
    .option('--room-num <n>', 'Number of rooms (match quote)', '1')
    .option('--adults <n>', 'Adults per room (match quote)', '2')
    .option('--children <n>', 'Children per room (match quote)', '0')
    .option('--nationality <code>', 'Guest nationality (ISO country code)', 'CN')
    .option('--guest-name <name>', 'Primary guest name')
    .option('--contact-name <name>', 'Booking contact name (may equal guest-name)')
    .option('--contact-phone <phone>', 'Booking contact phone number (digits)')
    .option('--contact-country-code <code>', "Phone country calling code without '+'", '86')
    .option('--contact-email <email>', 'Booking contact email')
    .option('--arrive-time <time>', 'Expected arrival time (HH:mm, hotel local time)')
    .option('--special-requests <text>', 'Free-text special requests (non-binding)')
    .option(
      '--payment-order-id <id>',
      'Do NOT use: hotel-redaug settles on account; any non-empty value is rejected with BILLING_MODE_MISMATCH',
    )
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, hotelBookSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // BILLING GUARD (requirement 4.6, design Property 7): hotel-redaug settles
    // exclusively on monthly_settlement. A non-empty --payment-order-id is a
    // mode mismatch rejected BEFORE any request; the value never enters the
    // body. Checked first so the rejection is unconditional.
    const paymentOrderId = opts.paymentOrderId as string | undefined;
    if (typeof paymentOrderId === 'string' && paymentOrderId.length > 0) {
      throw new CliError(
        'BILLING_MODE_MISMATCH',
        'hotel-redaug settles on account (monthly_settlement); --payment-order-id is not accepted. Remove it and retry with the same idempotency-key.',
      );
    }

    // Required + typed validation — ALL before any request → PARAM_INVALID.
    // snake_case keys match the platform contract; amounts stay decimal.
    const productToken = need(opts.productToken as string | undefined, 'product-token');
    const totalAmount = num(opts.totalAmount as string | undefined, 'total-amount');
    const currency = need(opts.currency as string | undefined, 'currency');
    const priceItems = parsePriceItems(need(opts.priceItems as string | undefined, 'price-items'));

    const checkIn = stayDate(opts.checkIn as string | undefined, 'check-in');
    const checkOut = stayDate(opts.checkOut as string | undefined, 'check-out');
    // Both are validated YYYY-MM-DD, so a lexical compare is a correct date
    // order; check-out must be strictly after check-in.
    if (!(checkOut > checkIn)) {
      throw new CliError('PARAM_INVALID', '--check-out must be strictly after --check-in.');
    }

    const guestName = need(opts.guestName as string | undefined, 'guest-name');
    const contactName = need(opts.contactName as string | undefined, 'contact-name');
    const contactPhone = need(opts.contactPhone as string | undefined, 'contact-phone');

    const body: Record<string, unknown> = {
      product_token: productToken,
      total_amount: totalAmount,
      currency,
      price_items: priceItems,
      check_in: checkIn,
      check_out: checkOut,
      room_num: num(opts.roomNum as string | undefined, 'room-num'),
      adults: num(opts.adults as string | undefined, 'adults'),
      children: num(opts.children as string | undefined, 'children'),
      nationality: opts.nationality as string,
      guest_name: guestName,
      contact_name: contactName,
      contact_phone: contactPhone,
      contact_country_code: opts.contactCountryCode as string,
    };

    // Optional fields — included only when supplied (omitted keys never enter
    // the body). --payment-order-id and --idempotency-key are NEVER in the body.
    if (opts.contactEmail !== undefined) body.contact_email = opts.contactEmail as string;
    if (opts.arriveTime !== undefined) body.arrive_time = opts.arriveTime as string;
    if (opts.specialRequests !== undefined) body.special_requests = opts.specialRequests as string;

    // Confirm before the write unless --yes. The prompt goes to stderr;
    // declining maps to CLIENT_ABORTED (exit 5) via the top-level envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Book hotel for ${checkIn} → ${checkOut}, total ${totalAmount} ${currency}?`,
        default: true,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Booking cancelled by user.');
      }
    }

    // Idempotency key (requirement 13.1-13.6): resolved before the request via
    // the reused merchant-cli policy. Under --yes a missing key is a hard error
    // and no request is sent. The key is sent as a header, never in the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'hotel-redaug book',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Booking hotel...');

    const result = await deps.apiClient.post<BookHotelResponse>(
      '/hotel/book',
      { type: 'api-key', key: apiKey },
      body,
      { 'Idempotency-Key': idempotencyKey },
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<BookHotelResponse> = {
      data,
      text: () => formatBook(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

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
import type { PriceItem } from '../types/hotel.js';
import { resolveIdempotencyKey } from '../idempotency.js';
import { attachSchemaHelp, hotelCreateOrderSchema } from '../verb-schema.js';

// ============================================================
// Structured-flag parser (pure builder — directly property-testable)
// ============================================================

/**
 * Parse and shape-validate `--price-items`.
 *
 * The raw flag MUST be a JSON array in which every element carries `sale_date`
 * (string), `sale_price` (number), and `breakfast_num` (number). Any deviation
 * — non-JSON, a non-array, or any element missing/mistyping a required field —
 * raises `PARAM_INVALID` before any request is issued.
 *
 * The parsed array is returned VERBATIM (the actual parsed objects, extra keys
 * untouched) and forwarded as-is in the request body: `sale_price` is a DECIMAL
 * currency amount and is never converted to/from minor units.
 *
 * Exported so tests and other verbs can import and exercise it directly.
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
// Response type
// ============================================================

export interface CreateHotelOrderResponse {
  order_id: string;
  fc_order_code: string;
  order_status: string;
  total_amount: number;
  currency: string;
  rooms?: Array<{ room_index: string; guest_name: string }>;
}

// ============================================================
// Input helpers (reused from book.ts pattern)
// ============================================================

function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

function num(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isFinite(n)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return n;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

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
// Output helper
// ============================================================

function formatCreateOrder(data: CreateHotelOrderResponse): string {
  const lines: [string, string][] = [
    ['Order ID', String(data.order_id ?? '-')],
    ['FC order code', String(data.fc_order_code ?? '-')],
    ['Order status', String(data.order_status ?? '-')],
    ['Total amount', `${data.total_amount} ${data.currency}`],
  ];

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
      `Order created with status AWAITING_PAYMENT — proceed with 'hotel-redaug pay-order --order-id ${data.order_id ?? '<order_id>'}' to settle.`,
    ),
  );

  return out.join('\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug create-order` — create a hotel order without charging any
 * account. Calls `POST /hotel/create-order` with `Idempotency-Key` header.
 * On success: exit 0, prints the created order_id to stdout.
 *
 * This is the first step of the create-then-pay flow; the order enters
 * AWAITING_PAYMENT status and must be settled via `pay-order`. Locking a rate
 * is a real commitment (though not a charge), so the non-`--yes` path MUST
 * confirm (restating amount/currency/dates) before the write; `--yes` skips
 * it. A declined confirm maps to `CLIENT_ABORTED` (exit 5).
 */
export function registerHotelCreateOrderCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('create-order')
    .description('Create a hotel order without charging (lock inventory, await payment)')
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
      '--reminder <html>',
      "客户自测点5 提示信息: the chosen quote rate's reminder HTML string. Stored on the order for the order-detail page ONLY — platform-local, not sent upstream.",
    )
    .option('--hotel-name <name>', 'Hotel name (display-only, stored for order summary)')
    .option(
      '--bed-type <code>',
      "Product bed-type code from the chosen quote rate's beds[].code (e.g. 'L000000' King / '1000000' Queen); forwarded verbatim to upstream createOrder bedType.",
    )
    .option(
      '--payment-token-id <id>',
      'UPI Agent Pay: payment token id from an already-completed UnionPay network-token capture. When set, the platform skips EVO preauth/capture and only locks the order + records this credential (funds already charged).',
    )
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, hotelCreateOrderSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Required + typed validation — ALL before any request → PARAM_INVALID.
    const productToken = need(opts.productToken as string | undefined, 'product-token');
    const totalAmount = num(opts.totalAmount as string | undefined, 'total-amount');
    const currency = need(opts.currency as string | undefined, 'currency');
    const priceItems = parsePriceItems(need(opts.priceItems as string | undefined, 'price-items'));

    const checkIn = stayDate(opts.checkIn as string | undefined, 'check-in');
    const checkOut = stayDate(opts.checkOut as string | undefined, 'check-out');
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

    // Optional fields — included only when supplied.
    if (opts.contactEmail !== undefined) body.contact_email = opts.contactEmail as string;
    if (opts.arriveTime !== undefined) body.arrive_time = opts.arriveTime as string;
    if (opts.specialRequests !== undefined) body.special_requests = opts.specialRequests as string;
    // 提示信息快照（客户自测点5）：上游 reminder HTML 字符串，原样传给平台落库、订单详情页按 HTML 渲染。
    if (opts.reminder !== undefined) body.reminder = opts.reminder as string;
    if (opts.hotelName !== undefined) body.hotel_name = opts.hotelName as string;
    if (opts.bedType !== undefined) body.bed_type = opts.bedType as string;
    if (opts.paymentTokenId !== undefined) body.payment_token_id = opts.paymentTokenId as string;

    // Confirm before the write unless --yes. This locks inventory at the quoted
    // rate — the user must have already picked this hotel/rate (from search +
    // quote), so the prompt restates what is being locked in before the call is
    // made. The prompt goes to stderr; declining maps to CLIENT_ABORTED (exit 5)
    // via the top-level envelope.
    if (!isYes) {
      const chargeNote = opts.paymentTokenId !== undefined
        ? 'Payment has already been captured via UPI Agent Pay; this only locks the room.'
        : 'This locks the rate but does NOT charge anything yet.';
      const confirmed = await confirm({
        message: `Create this hotel order for ${totalAmount} ${currency} (check-in ${checkIn}, check-out ${checkOut})? ${chargeNote}`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Order creation aborted by user.');
      }
    }

    // Idempotency key resolution — under --yes a missing key is a hard error.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'hotel-redaug create-order',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Creating hotel order...');

    const result = await deps.apiClient.post<CreateHotelOrderResponse>(
      '/hotel/create-order',
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
    const commandResult: CommandResult<CreateHotelOrderResponse> = {
      data,
      text: () => formatCreateOrder(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

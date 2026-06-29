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
import type { CheckoutHotelResponse, CheckoutRoom } from '../types/hotel.js';
import { attachSchemaHelp, hotelCheckoutSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/cancel.ts and the sibling
// hotel-redaug/book.ts and cancel.ts each define their own need/num) rather
// than pulled from a shared helpers file.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 7.3 / design §4.4) — a catalog code (exit 1), mirroring the
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
 * Number-ify a numeric flag. Non-finite input maps to `PARAM_INVALID`. Used for
 * `--refund-type` (an upstream refund-handling code; default 1).
 */
function num(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isFinite(n)) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a number.`);
  }
  return n;
}

// ============================================================
// Structured-flag parser (pure builder — directly property-testable)
// ============================================================

/**
 * Parse and shape-validate `--checkout-rooms` (requirement 7.4, design Property 3).
 *
 * The raw flag MUST be a JSON array in which every element carries `room_index`
 * (string), `guest_name` (string), and `cancel_check_in_date` (string). Any
 * deviation — non-JSON, a non-array, or any element missing/mistyping a required
 * field — raises `PARAM_INVALID` before any request is issued.
 *
 * `room_index` and `guest_name` come VERBATIM from the `book` response
 * `rooms[]`; `cancel_check_in_date` is the check-in date of the night(s) being
 * dropped. The parsed array is returned VERBATIM (the actual parsed objects,
 * extra keys untouched) and forwarded as-is in the request body.
 *
 * Exported so the task-6 property suite can import and exercise it directly.
 */
export function parseCheckoutRooms(raw: string): CheckoutRoom[] {
  const INVALID =
    '--checkout-rooms must be a JSON array of {room_index (string), guest_name (string), cancel_check_in_date (string)}.';

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
    const room = el as Record<string, unknown>;
    if (
      typeof room.room_index !== 'string' ||
      typeof room.guest_name !== 'string' ||
      typeof room.cancel_check_in_date !== 'string'
    ) {
      throw new CliError('PARAM_INVALID', INVALID);
    }
  }

  // Forwarded verbatim — the parsed objects are returned unchanged.
  return parsed as CheckoutRoom[];
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render a check-out application result as a key/value block for
 * `--format table`. The synchronous response is an ACCEPTANCE only: it returns a
 * `task_order_code` while the supplier decides asynchronously. A closing info
 * line conveys the async contract (requirement 7.6): poll `get-checkout` with
 * the `task_order_code` until a terminal refund status.
 */
function formatCheckout(data: CheckoutHotelResponse): string {
  const lines: [string, string][] = [
    ['Order ID', String(data.order_id ?? '-')],
    ['Task order code', String(data.task_order_code ?? '-')],
  ];
  if (data.apply_status !== undefined && data.apply_status !== null) {
    lines.push(['Apply status', String(data.apply_status)]);
  }
  if (data.checkout_status !== undefined) {
    lines.push(['Checkout status', String(data.checkout_status)]);
  }

  const out: string[] = [Formatter.keyValue(lines)];

  out.push(
    '',
    Formatter.status(
      'info',
      `Check-out is ASYNC — this response is acceptance only, NOT proof of refund. Poll 'hotel-redaug get-checkout --task-order-code ${data.task_order_code ?? '<task_order_code>'}' until refund_status is approved/rejected/refunded.`,
    ),
  );

  return out.join('\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug checkout` — request a partial check-out or an out-of-policy
 * cancellation (§ checkout schema). Write op (W/Y) — an APPLICATION the property
 * must approve; charges/refund are decided asynchronously.
 *
 * `POST /hotel/<order-id>/checkout` with `X-Api-Key` auth, the resolved
 * `Idempotency-Key` header (key forwarded verbatim, never in the body), and a
 * snake_case body `{ fc_order_code, reason, refund_type, checkout_rooms }`.
 * `--order-id` is the URL path; `--fc-order-code` rides in the body. All flag
 * validation — required fields (`--order-id`, `--fc-order-code`, `--reason`,
 * `--checkout-rooms`), the `--checkout-rooms` JSON shape, and numeric
 * `--refund-type` — raises `PARAM_INVALID` before any request is sent. `--yes`
 * skips the confirm; a declined confirm maps to `CLIENT_ABORTED` (exit 5); a
 * missing `--idempotency-key` under `--yes` throws
 * `PARAM_IDEMPOTENCY_KEY_REQUIRED` before any request, otherwise it is prompted.
 *
 * Renders `CheckoutHotelResponse` via `renderWithContext` (json carries the
 * profile/endpoint envelope); the progress spinner goes to stderr and stays
 * silent in json mode. The synchronous response is ACCEPTANCE ONLY — the Agent
 * must poll `get-checkout` until a terminal refund status (requirement 7.6).
 * Named `registerHotelCheckoutCommand` to avoid clashing with the `ride-elife`
 * registrars when both are imported into `index.ts`.
 */
export function registerHotelCheckoutCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('checkout')
    .description('Request a partial check-out or an out-of-policy cancellation (async; the property must approve)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Our order reference (coOrderCode) for the URL path (book.response.order_id)')
    .option('--fc-order-code <code>', 'Supplier order reference of the booking to change (book.response.fc_order_code)')
    .option('--reason <text>', 'Why the partial check-out / out-of-policy cancellation is requested')
    .option(
      '--checkout-rooms <json>',
      'Rooms to check out of as a JSON array of {room_index, guest_name, cancel_check_in_date} (room_index/guest_name copied verbatim from book.response.rooms[])',
    )
    .option('--refund-type <type>', 'Requested refund handling (upstream refund-type code)', '1')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, hotelCheckoutSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Required + typed validation — ALL before any request → PARAM_INVALID.
    // snake_case keys match the platform contract. --order-id is the URL path;
    // --fc-order-code rides in the body.
    const orderId = need(opts.orderId as string | undefined, 'order-id');
    const fcOrderCode = need(opts.fcOrderCode as string | undefined, 'fc-order-code');
    const reason = need(opts.reason as string | undefined, 'reason');
    const checkoutRooms = parseCheckoutRooms(need(opts.checkoutRooms as string | undefined, 'checkout-rooms'));
    const refundType = num(opts.refundType as string | undefined, 'refund-type');

    const body: Record<string, unknown> = {
      fc_order_code: fcOrderCode,
      reason,
      refund_type: refundType,
      checkout_rooms: checkoutRooms,
    };

    // Confirm before the write unless --yes. A check-out application may incur
    // charges and must be approved by the property, so the prompt makes that
    // explicit. The prompt goes to stderr; declining maps to CLIENT_ABORTED
    // (exit 5) via the top-level envelope.
    if (!isYes) {
      const confirmed = await confirm({
        message: `Request check-out / out-of-policy cancellation for order ${orderId} (${checkoutRooms.length} room(s))? The property must approve and charges may apply.`,
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Check-out application aborted by user.');
      }
    }

    // Idempotency key (requirement 13.1-13.6): resolved before the request via
    // the reused merchant-cli policy. Under --yes a missing key is a hard error
    // and no request is sent. The key is sent as a header, never in the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'hotel-redaug checkout',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Submitting check-out application...');

    const result = await deps.apiClient.post<CheckoutHotelResponse>(
      `/hotel/${encodeURIComponent(orderId)}/checkout`,
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
    const commandResult: CommandResult<CheckoutHotelResponse> = {
      data,
      text: () => formatCheckout(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

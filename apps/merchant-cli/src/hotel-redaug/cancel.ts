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
import type { CancelHotelResponse } from '../types/hotel.js';
import { attachSchemaHelp, hotelCancelSchema } from '../verb-schema.js';
import { resolveIdempotencyKey } from '../idempotency.js';

// ============================================================
// Input helpers (hotel-domain — body assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/cancel.ts and the sibling
// hotel-redaug/book.ts each define their own need) rather than pulled from a
// shared helpers file.

/**
 * Require a flag value. Missing required input maps to `PARAM_INVALID`
 * (requirement 6.3 / design §4.4) — a catalog code (exit 1), mirroring the
 * `ride-elife` convention; `PARAM_REQUIRED` is intentionally not used (it is
 * not in the cli-core error catalog).
 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render a cancellation result as a key/value block for `--format table`.
 *
 * The platform returns one of TWO shapes (modeled on
 * `order_mapping.format_cancel` / `format_cancel_pending`), and this formatter
 * handles BOTH:
 *   - CONFIRMED shape — a `cancellation` breakdown (`cancellation_fee`,
 *     `reversal_amount`, `currency`) and/or a flat `cancellation_fee`, plus a
 *     `refund_amount`.
 *   - ACCEPTED-BUT-PENDING shape — `cancel_status` is `'cancel_pending'` with an
 *     upstream `cancel_result` acknowledgement (no fee/refund settled yet).
 *
 * Amounts are decimal currency units (NOT cents) — printed verbatim. A closing
 * info line conveys the acceptance-is-not-proof contract (requirement 6.5): a
 * successful response is acceptance only, so the Agent MUST poll `get` until
 * `order_status=CANCELLED` (code 4) to confirm the cancellation actually took
 * effect.
 */
function formatCancel(data: CancelHotelResponse): string {
  const lines: [string, string][] = [
    ['Order ID', String(data.order_id ?? '-')],
    ['Order status', String(data.order_status ?? '-')],
  ];

  // Accepted-but-pending shape: surface the pending marker so the operator sees
  // the cancellation was only accepted, not yet observed as CANCELLED.
  if (data.cancel_status !== undefined) {
    lines.push(['Cancel status', String(data.cancel_status)]);
  }

  // Confirmed shape: prefer the structured `cancellation` breakdown, falling
  // back to the flat `cancellation_fee` when only that is present.
  if (data.cancellation) {
    const c = data.cancellation;
    const cur = c.currency ? ` ${c.currency}` : '';
    if (c.cancellation_fee !== undefined) {
      lines.push(['Cancellation fee', `${c.cancellation_fee}${cur}`]);
    }
    if (c.reversal_amount !== undefined) {
      lines.push(['Reversal amount', `${c.reversal_amount}${cur}`]);
    }
  } else if (data.cancellation_fee !== undefined && data.cancellation_fee !== null) {
    lines.push(['Cancellation fee', String(data.cancellation_fee)]);
  }

  if (data.refund_amount !== undefined && data.refund_amount !== null) {
    lines.push(['Refund amount', String(data.refund_amount)]);
  }

  const out: string[] = [Formatter.keyValue(lines)];

  out.push(
    '',
    Formatter.status(
      'info',
      `A successful response is acceptance only, NOT proof of cancellation — poll 'hotel-redaug get --order-id ${data.order_id ?? '<order_id>'}' until order_status=CANCELLED (code 4) to confirm.`,
    ),
  );

  return out.join('\n');
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug cancel` — cancel an entire hotel order within its cancellation
 * policy (§ cancel schema). Write op (W/Y) — a cancellation fee may apply.
 *
 * `POST /hotel/<order-id>/cancel` with `X-Api-Key` auth, the resolved
 * `Idempotency-Key` header (key forwarded verbatim, never in the body), and a
 * snake_case body carrying `fc_order_code` (and `reason` when supplied).
 * Required-flag validation (`--order-id`, `--fc-order-code`) raises
 * `PARAM_INVALID` before any request is sent. There is NO interactive cancel
 * confirmation prompt (it was removed so the command never blocks on stdin);
 * cancel proceeds directly. A missing `--idempotency-key` under `--yes` throws
 * `PARAM_IDEMPOTENCY_KEY_REQUIRED` before any request, otherwise it is prompted.
 *
 * Renders `CancelHotelResponse` (both the confirmed and the accepted-but-pending
 * shapes) via `renderWithContext` (json carries the profile/endpoint envelope);
 * the progress spinner goes to stderr and stays silent in json mode. A
 * successful response is ACCEPTANCE ONLY — the Agent must poll `get` until
 * `order_status=CANCELLED` (code 4) to confirm (requirement 6.5).
 */
export function registerHotelCancelCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('cancel')
    .description('Cancel a whole hotel order within its policy (a cancellation fee may apply)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-id <id>', 'Our order reference (coOrderCode) to cancel (book.response.order_id)')
    .option('--fc-order-code <code>', 'Supplier order reference (book.response.fc_order_code)')
    .option('--reason <text>', 'Cancellation reason')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, hotelCancelSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Required input throws PARAM_INVALID before any request is sent (mirrors
    // the sibling book/get commands). snake_case keys match the platform
    // contract; --order-id is the URL path, --fc-order-code rides in the body.
    const orderId = need(opts.orderId as string | undefined, 'order-id');
    const fcOrderCode = need(opts.fcOrderCode as string | undefined, 'fc-order-code');

    const body: Record<string, unknown> = { fc_order_code: fcOrderCode };
    // Optional reason — included only when supplied (an omitted key never
    // enters the body). --idempotency-key is NEVER in the body.
    if (opts.reason !== undefined) body.reason = opts.reason as string;

    // No interactive cancel confirmation — cancel proceeds directly (the extra
    // "A cancellation fee may apply" y/N prompt was removed so the command never
    // blocks on stdin in non-interactive/automation contexts).

    // Idempotency key (requirement 13.1-13.6): resolved before the request via
    // the reused merchant-cli policy. Under --yes a missing key is a hard error
    // and no request is sent. The key is sent as a header, never in the body.
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'hotel-redaug cancel',
    });

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Cancelling hotel order...');

    const result = await deps.apiClient.post<CancelHotelResponse>(
      `/hotel/${encodeURIComponent(orderId)}/cancel`,
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
    const commandResult: CommandResult<CancelHotelResponse> = {
      data,
      text: () => formatCancel(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

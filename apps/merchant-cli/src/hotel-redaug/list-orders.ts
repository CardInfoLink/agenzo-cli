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
import type { ListHotelOrdersResponse, HotelOrderListItem } from '../types/hotel.js';
import { attachSchemaHelp, hotelListOrdersSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (hotel-domain — query assembly stays in app per req 15.3)
// ============================================================
//
// Defined locally (mirroring how ride-elife/list-orders.ts and the sibling
// hotel-redaug verbs each define their own helpers) rather than pulled from a
// shared helpers file. `list-orders` is read-only — no idempotency key.

const DEFAULT_PAGE = '1';
const DEFAULT_PAGE_SIZE = '20';

/**
 * Number-ify a pagination flag. Non-finite / non-integer / non-positive input
 * maps to `PARAM_INVALID` (catalog code, exit 1) BEFORE any request is sent
 * (requirement 9.3) — mirroring the `ride-elife/list-orders.ts` convention.
 * Returns the canonical string form to be passed through as a query parameter.
 */
function positiveInt(value: string, flag: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a positive integer.`);
  }
  return String(n);
}

// ============================================================
// Output helper (table summary)
// ============================================================

/**
 * Render the hotel order list as a table for `--format table`. Each order is
 * one row; the price column pairs `price_amount` with `price_currency` as a
 * DECIMAL currency amount (NOT cents) — printed verbatim. An empty `orders`
 * list is a successful result, so it renders an info line (never an error).
 */
function formatOrders(data: ListHotelOrdersResponse): string {
  const orders: HotelOrderListItem[] = data.orders ?? [];
  if (orders.length === 0) {
    return Formatter.status('info', 'No hotel orders found');
  }

  const headers = ['Order ID', 'FC Order Code', 'Status', 'Check-in', 'Check-out', 'Price', 'Payment'];
  const rows = orders.map((o) => [
    String(o.order_id ?? '-'),
    String(o.fc_order_code ?? '-'),
    String(o.status ?? '-'),
    String(o.check_in ?? '-'),
    String(o.check_out ?? '-'),
    o.price_amount != null ? `${o.price_amount} ${o.price_currency ?? ''}`.trim() : '-',
    String(o.payment_status ?? '-'),
  ]);

  const summary: [string, string][] = [
    ['Total', String(data.total ?? '-')],
    ['Page', String(data.page ?? '-')],
    ['Page size', String(data.page_size ?? '-')],
  ];

  return `${Formatter.table(headers, rows)}\n${Formatter.keyValue(summary)}`;
}

// ============================================================
// Command registration
// ============================================================

/**
 * `hotel-redaug list-orders` — list the developer's hotel orders with optional
 * status filtering and pagination (§ list-orders schema). Read-only (no
 * idempotency key).
 *
 * Passes `--page`(default 1) / `--page-size`(default 20) / `--status` through
 * as query parameters to `GET /hotel/orders` with the `X-Api-Key` auth, and
 * renders `ListHotelOrdersResponse` via `renderWithContext` (json carries the
 * profile/endpoint envelope). `page`/`page-size` are validated as positive
 * integers (invalid → `PARAM_INVALID` before any request); `status` is
 * forwarded if and only if `--status` was supplied (omitted entirely when
 * absent → all statuses, requirement 9.4). The progress line is emitted through
 * the spinner so it goes to stderr and stays silent in json mode.
 */
export function registerHotelListOrdersCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list-orders')
    .description('List the developer\'s hotel orders with optional status filtering and pagination')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--status <status>', 'Filter by order status (omitted entirely when absent → all statuses)')
    .option('--page <page>', 'Page number', DEFAULT_PAGE)
    .option('--page-size <size>', 'Page size', DEFAULT_PAGE_SIZE);

  attachSchemaHelp(cmd, hotelListOrdersSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build query params. page/page-size are validated as positive integers
    // (invalid → PARAM_INVALID before any request); status is forwarded
    // verbatim if and only if --status was supplied. Sent as a query string,
    // never a body.
    const params: Record<string, string> = {
      page: positiveInt((opts.page as string | undefined) ?? DEFAULT_PAGE, 'page'),
      page_size: positiveInt((opts.pageSize as string | undefined) ?? DEFAULT_PAGE_SIZE, 'page-size'),
    };
    if (opts.status !== undefined) params.status = opts.status as string;

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Fetching orders...');

    const result = await deps.apiClient.get<ListHotelOrdersResponse>(
      '/hotel/orders',
      { type: 'api-key', key: apiKey },
      params,
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<ListHotelOrdersResponse> = {
      data,
      text: () => formatOrders(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

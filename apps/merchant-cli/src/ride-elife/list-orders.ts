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
import type { ListOrdersResponse, RideOrderListItem } from '../types/api.js';
import { attachSchemaHelp, listOrdersSchema } from '../verb-schema.js';

// ============================================================
// Input helpers (ride-domain — stays in app per req 4.4)
// ============================================================

const DEFAULT_PAGE = '1';
const DEFAULT_PAGE_SIZE = '20';

/**
 * Number-ify a pagination flag. Non-finite / non-integer / non-positive input
 * maps to `PARAM_INVALID` (catalog code, exit 1) — mirroring the sibling
 * quote/get/cancel commands' convention. Returns the canonical string form to
 * be passed through as a query parameter.
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
 * Render the order list as a table for `--format table`. Each order is one
 * row; amounts are decimal currency units (NOT cents) — printed verbatim.
 */
function formatOrders(data: ListOrdersResponse): string {
  const orders: RideOrderListItem[] = data.orders ?? [];
  if (orders.length === 0) {
    return Formatter.status('info', 'No ride orders found');
  }

  const headers = ['Order ID', 'Ride ID', 'Status', 'Vehicle Class', 'Price', 'Currency', 'Payment'];
  const rows = orders.map((o) => [
    String(o.order_id ?? '-'),
    String(o.ride_id ?? '-'),
    String(o.status ?? '-'),
    String(o.vehicle_class ?? '-'),
    String(o.price_amount ?? '-'),
    String(o.price_currency ?? '-'),
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
 * `ride-elife list-orders` — list previously placed ride orders (§4.4.1.3
 * list-orders schema). Read-only (no idempotency key).
 *
 * Passes `--page`(default 1) / `--page-size`(default 20) / `--status` /
 * `--order-type` through as query parameters to `GET /ride/orders` with the
 * `X-Api-Key` auth, and renders `ListOrdersResponse` via `renderWithContext`
 * (json carries the profile/endpoint envelope). `page`/`page-size` are
 * validated as positive integers (invalid → `PARAM_INVALID`); `status` /
 * `order-type` are forwarded verbatim only when set. The progress line is
 * emitted through `notify` so it goes to stderr and stays silent in json mode.
 */
export function registerListOrdersCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list-orders')
    .description('List previously placed ride orders')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--page <page>', 'Page number', DEFAULT_PAGE)
    .option('--page-size <size>', 'Page size', DEFAULT_PAGE_SIZE)
    .option('--status <status>', 'Filter by order status')
    .option('--order-type <type>', 'Filter by order type');

  attachSchemaHelp(cmd, listOrdersSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build query params. page/page-size are validated as positive integers
    // (invalid → PARAM_INVALID before any request); status/order-type are
    // forwarded verbatim only when set. Sent as a query string, never a body.
    const params: Record<string, string> = {
      page: positiveInt((opts.page as string | undefined) ?? DEFAULT_PAGE, 'page'),
      page_size: positiveInt((opts.pageSize as string | undefined) ?? DEFAULT_PAGE_SIZE, 'page-size'),
    };
    if (opts.status !== undefined) params.status = opts.status as string;
    if (opts.orderType !== undefined) params.order_type = opts.orderType as string;

    // Animated spinner: visible in table mode, silent in json mode.
    const spinner = format === 'json' ? null : createSpinner('Fetching orders...');

    const result = await deps.apiClient.get<ListOrdersResponse>(
      '/ride/orders',
      { type: 'api-key', key: apiKey },
      params,
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<ListOrdersResponse> = {
      data,
      text: () => formatOrders(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

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
import type { UnifiedListOrdersResponse, UnifiedOrderListItem } from '../types/api.js';
import { attachSchemaHelp, unifiedOrdersListSchema } from '../verb-schema.js';

// ============================================================
// Input helpers
// ============================================================

const DEFAULT_PAGE = '1';
const DEFAULT_PAGE_SIZE = '20';

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
 * Render the unified order list as a table for `--format table`. Kept to a
 * SMALL, fixed column set (order_id / type / status / amount / currency) —
 * cross-provider items intentionally carry no domain-specific columns (hotel
 * name, vehicle class, etc.); those live behind `orders get`.
 */
function formatOrders(data: UnifiedListOrdersResponse): string {
  const orders: UnifiedOrderListItem[] = data.orders ?? [];
  if (orders.length === 0) {
    return Formatter.status('info', 'No orders found');
  }

  const headers = ['Order ID', 'Type', 'Status', 'Amount', 'Currency'];
  const rows = orders.map((o) => [
    String(o.order_id ?? '-'),
    String(o.order_type ?? '-'),
    String(o.status ?? '-'),
    String(o.amount ?? '-'),
    String(o.currency ?? '-'),
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
 * `orders list` — cross-provider order list (`GET /orders`). This is the
 * ONLY tool that spans ride + hotel (+ future providers) in one call; use it
 * whenever the user asks for "my orders" / "order history" without naming a
 * specific business (ride vs hotel). Use `ride-elife list-orders` /
 * `hotel-redaug list-orders` only when the user explicitly asks about rides
 * or hotels specifically, or once you already know the order_type and want
 * domain-specific columns.
 */
export function registerOrdersListCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list')
    .description('List orders across ALL providers (ride + hotel), with optional type/status filters')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-type <type>', 'Filter by order type: ride | hotel')
    .option('--status <status>', 'Filter by normalized status: PENDING | CONFIRMED | COMPLETED | CANCELLED | FAILED')
    .option('--page <page>', 'Page number', DEFAULT_PAGE)
    .option('--page-size <size>', 'Page size', DEFAULT_PAGE_SIZE);

  attachSchemaHelp(cmd, unifiedOrdersListSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    const params: Record<string, string> = {
      page: positiveInt((opts.page as string | undefined) ?? DEFAULT_PAGE, 'page'),
      page_size: positiveInt((opts.pageSize as string | undefined) ?? DEFAULT_PAGE_SIZE, 'page-size'),
    };
    if (opts.orderType !== undefined) params.order_type = opts.orderType as string;
    if (opts.status !== undefined) params.status = opts.status as string;

    const spinner = format === 'json' ? null : createSpinner('Fetching orders...');

    const result = await deps.apiClient.get<UnifiedListOrdersResponse>(
      '/orders',
      { type: 'api-key', key: apiKey },
      params,
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<UnifiedListOrdersResponse> = {
      data,
      text: () => formatOrders(data),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

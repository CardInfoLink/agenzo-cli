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
import { MEMBER_OPTION_DESCRIPTION, memberIdOf } from '../member.js';

const DEFAULT_PAGE = '1';
const DEFAULT_PAGE_SIZE = '20';

function positiveInt(value: string, flag: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new CliError('PARAM_INVALID', `--${flag} must be a positive integer.`);
  }
  return String(n);
}

function assertCompatibleOptions(opts: Record<string, unknown>): void {
  if (opts.orderType !== undefined && opts.orderTypes !== undefined) {
    throw new CliError('PARAM_INVALID', '--order-type and --order-types cannot be used together.');
  }
  if (opts.status !== undefined && opts.statuses !== undefined) {
    throw new CliError('PARAM_INVALID', '--status and --statuses cannot be used together.');
  }
  if (opts.cursor !== undefined && Number(opts.page ?? DEFAULT_PAGE) !== 1) {
    throw new CliError('PARAM_INVALID', '--cursor cannot be combined with --page greater than 1.');
  }
}

/** Render a compact cross-provider list summary for table output. */
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
  if (data.has_more !== undefined) summary.push(['Has more', String(data.has_more)]);
  if (data.next_cursor) summary.push(['Next cursor', data.next_cursor]);

  return `${Formatter.table(headers, rows)}\n${Formatter.keyValue(summary)}`;
}

/**
 * `orders list` — cross-provider order list (`GET /orders`). This is the
 * only list spanning ride, hotel, and flight in one call. Domain-specific
 * list commands remain available when provider-specific columns are needed.
 */
export function registerOrdersListCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list')
    .description('List orders across ALL providers (ride + hotel + flight), with filters and pagination')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--order-type <type>', 'Legacy single order type filter: ride | hotel | flight')
    .option('--order-types <types>', 'Comma-separated order types: ride,hotel,flight')
    .option('--status <status>', 'Legacy single normalized status filter')
    .option('--statuses <statuses>', 'Comma-separated statuses: PENDING,CONFIRMED,COMPLETED,CANCELLED,FAILED')
    .option('--created-from <datetime>', 'Created at or after this ISO 8601 datetime (inclusive)')
    .option('--created-to <datetime>', 'Created before this ISO 8601 datetime (exclusive)')
    .option('--cursor <cursor>', 'Opaque cursor returned by the previous page')
    .option('--page <page>', 'Legacy 1-based page number', DEFAULT_PAGE)
    .option('--page-size <size>', 'Page size', DEFAULT_PAGE_SIZE)
    .option('--member <id>', MEMBER_OPTION_DESCRIPTION);

  attachSchemaHelp(cmd, unifiedOrdersListSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    assertCompatibleOptions(opts);
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
    if (opts.orderTypes !== undefined) params.order_types = opts.orderTypes as string;
    if (opts.status !== undefined) params.status = opts.status as string;
    if (opts.statuses !== undefined) params.statuses = opts.statuses as string;
    if (opts.createdFrom !== undefined) params.created_from = opts.createdFrom as string;
    if (opts.createdTo !== undefined) params.created_to = opts.createdTo as string;
    if (opts.cursor !== undefined) params.cursor = opts.cursor as string;
    const member = memberIdOf(opts);
    if (member !== undefined) params.member_id = member;

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

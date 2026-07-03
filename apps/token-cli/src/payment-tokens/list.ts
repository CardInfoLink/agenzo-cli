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
import { attachSchemaHelp, ptListSchema } from '../verb-schema.js';

// ============================================================
// getSummary — per-type summary for table rendering (§3.4.2)
// ============================================================

/**
 * Render a one-line summary for a payment token in the list table.
 *
 * - vcn: `<first6>****<last4> $<limit/100>` (e.g. "411111****1234 $25.00")
 * - network_token: `<brand>` (e.g. "Visa")
 * - x402: `<amount> <network>` (e.g. "1000000 Base")
 */
function getSummary(token: Record<string, unknown>): string {
  const type = token.type as string;

  if (type === 'vcn') {
    const first6 = String(token.first6 || token.first_six || '');
    const last4 = String(token.last4 || token.last_four || '');
    const limit = token.amount_limit as number | undefined ?? token.limit as number | undefined;
    const limitDisplay = limit !== undefined && limit !== null
      ? `$${(limit / 100).toFixed(2)}`
      : '';
    return `${first6}****${last4} ${limitDisplay}`.trim();
  }

  if (type === 'network_token') {
    const nt = token.network_token as Record<string, unknown> | undefined;
    return String(nt?.payment_brand || token.brand || '');
  }

  if (type === 'x402') {
    const amount = String(token.amount ?? '');
    const network = String(token.network || '');
    return `${amount} ${network}`.trim();
  }

  return '';
}

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-tokens list` — list payment tokens (§3.4.2).
 *
 * GET /payment-tokens with X-Api-Key header.
 * Optional --type flag maps to ?type= query param.
 * Optional --member flag maps to ?member_id= query param.
 * Table headers: Token ID / Type / Status / Summary.
 * Empty list → `ℹ No payment tokens found` (no table).
 */
export function registerListCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('list')
    .description('List payment tokens')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--type <type>', 'Filter by token type')
    .option('--member <member_id>', 'Filter by member ID');

  attachSchemaHelp(cmd, ptListSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Build query params
    const params: Record<string, string> = {};
    if (opts.type) {
      params.type = opts.type as string;
    }
    if (opts.member) {
      params.member_id = opts.member as string;
    }

    const result = await deps.apiClient.get<Record<string, unknown>[]>(
      '/payment-tokens',
      { type: 'api-key', key: apiKey },
      Object.keys(params).length > 0 ? params : undefined,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const tokens = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<{ payment_tokens: Record<string, unknown>[] }> = {
      data: { payment_tokens: tokens },
      text: () => {
        if (tokens.length === 0) {
          return Formatter.status('info', 'No payment tokens found');
        }
        const headers = ['Token ID', 'Type', 'Status', 'Summary'];
        const rows = tokens.map((t) => [
          String(t.id || ''),
          String(t.type || ''),
          String(t.status || ''),
          getSummary(t),
        ]);
        return Formatter.table(headers, rows);
      },
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

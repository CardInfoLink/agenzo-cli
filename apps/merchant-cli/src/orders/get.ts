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
import type { UnifiedOrderDetailResponse } from '../types/api.js';
import { MEMBER_OPTION_DESCRIPTION, memberIdOf } from '../member.js';
import { attachSchemaHelp, unifiedOrdersGetSchema } from '../verb-schema.js';

/**
 * `orders get` — cross-provider order detail (`GET /orders/{id}`). The
 * platform resolves order_id -> order_type from the unified index and
 * delegates to the owning domain's detail query; the response shape therefore
 * varies by order_type (ride vs hotel) — treat it as an opaque object and
 * surface whatever fields it contains.
 */
export function registerOrdersGetCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('get')
    .description('Get a single order detail by id, regardless of provider (ride/hotel)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--member <id>', MEMBER_OPTION_DESCRIPTION)
    .requiredOption('--order-id <id>', 'Order id (e.g. rio_... or hho_...)');

  attachSchemaHelp(cmd, unifiedOrdersGetSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    const spinner = format === 'json' ? null : createSpinner('Fetching order...');

    // 归因 + 归属：orchestrator 从已验签 JWT 注入（`source: 'session'`，对 LLM 不可见）。
    // 订单带 member_id 时平台按它校验归属，缺省则只按 developer+org 判定 —— 见
    // doc/member-id-attribution-design.md 修订后的不变量 2。
    const member = memberIdOf(opts);
    const params: Record<string, string> = {};
    if (member !== undefined) params.member_id = member;

    const result = await deps.apiClient.get<UnifiedOrderDetailResponse>(
      `/orders/${encodeURIComponent(opts.orderId as string)}`,
      { type: 'api-key', key: apiKey },
      params,
    );

    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    const configManager = new ConfigManager();
    const commandResult: CommandResult<UnifiedOrderDetailResponse> = {
      data,
      text: () =>
        Formatter.keyValue(
          Object.entries(data).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]),
        ),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

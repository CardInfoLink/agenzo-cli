import { Command } from 'commander';
import { CliError, Formatter, createSpinner, resolveFormat } from '@agenzo/cli-core';
import type { VerifyFlightResponse } from '../types/flight.js';
import { attachSchemaHelp, flightVerifySchema } from '../verb-schema.js';
import { type Deps, need, num, render, resolveApiKey } from './_helpers.js';

/** `flight-flink verify` — pre-booking price verification. */
export function registerVerifyCommand(parent: Command, deps: Deps): void {
  const cmd = parent
    .command('verify')
    .description('Verify the latest price before booking; returns the authoritative product_token')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option('--product-token <token>', 'Opaque token from search')
    // 任务 4「价格变了自动刷新」：以下 5 个全部可选，缺省不下发（请求体与加入前逐字相同）。
    // previous-total-price：选中那一轮 offer 的总价；带上它，供应商 1002/1950 时平台会按
    // token 自解行程重搜一次找回同一班，响应带回 previous_total_price 供确认卡显示 原价→新价。
    // 其余 4 个仅重搜时使用（token 里没有舱位/乘客数），保证找回用户原本选定的那档产品。
    .option('--previous-total-price <n>', 'Total price of the selected offer; enables the one-shot re-search refresh on supplier 1002/1950')
    .option('--cabin-class <c>', 'Cabin class to re-search with (economy | premium_economy | business | first)')
    .option('--adult-num <n>', 'Adults to re-search with (1-9)')
    .option('--child-num <n>', 'Children to re-search with (0-9)')
    .option('--infant-num <n>', 'Infants to re-search with (0-9)');
  attachSchemaHelp(cmd, flightVerifySchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await resolveApiKey(opts.apiKey as string | undefined);
    const productToken = need(opts.productToken as string | undefined, 'product-token');

    const body: Record<string, unknown> = { product_token: productToken };
    if (opts.previousTotalPrice !== undefined) {
      body.previous_total_price = num(opts.previousTotalPrice as string, 'previous-total-price');
    }
    if (opts.cabinClass !== undefined) body.cabin_class = opts.cabinClass as string;
    if (opts.adultNum !== undefined) body.adult_num = num(opts.adultNum as string, 'adult-num');
    if (opts.childNum !== undefined) body.child_num = num(opts.childNum as string, 'child-num');
    if (opts.infantNum !== undefined) body.infant_num = num(opts.infantNum as string, 'infant-num');

    const spinner = format === 'json' ? null : createSpinner('Verifying price...');
    const result = await deps.apiClient.post<VerifyFlightResponse>(
      '/flight/verify',
      { type: 'api-key', key: apiKey },
      body,
    );
    spinner?.stop();
    if (!result.success) throw CliError.fromApi(result, { auth: 'api-key' });
    await render(result.data, opts.format as string | undefined, (d) =>
      Formatter.keyValue([
        ['Product token', String(d.product_token ?? '-')],
        ['Total price', `${d.total_price ?? '-'} ${d.currency ?? ''}`.trim()],
        ['Price changed', String(d.price_changed)],
        // 刷新路径：平台带回选中时的原价，人读 output 里直接看出 原价 → 新价。
        ...(d.previous_total_price != null
          ? ([['Previous total price', String(d.previous_total_price)]] as [string, string][])
          : []),
      ]),
    );
  });
}

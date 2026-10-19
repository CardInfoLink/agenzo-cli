import { CliError } from '@agenzo/cli-core';

/**
 * Visa 取凭证时的一次性动态数据类型，对应平台的 `visa.dynamic_data_type`。
 *
 * - `TAVV`（平台默认）：28 位 cryptogram，响应在 `network_token.cryptogram`，提交给支持网络令牌的收单渠道。
 * - `DAVV`（原名 DTVV）：3 位动态 CVV，响应在 `network_token.cvv`，连同令牌卡号和有效期填普通卡表单。
 *
 * 一次只取一种；两种都要就取两次，各占一份授权额度。
 */
export const DYNAMIC_DATA_TYPES = ['TAVV', 'DAVV'] as const;
export type DynamicDataType = (typeof DYNAMIC_DATA_TYPES)[number];

export const DYNAMIC_DATA_TYPE_OPTION_HELP =
  'Which one-time dynamic data to fetch with the credential: TAVV (default) = 28-char cryptogram for acquirers that accept network-token cryptograms (returned as network_token.cryptogram); DAVV = 3-digit dynamic CVV to type into a normal card form together with the token number and expiry (returned as network_token.cvv). One type per call: fetch twice for both, each counts against the authorization limit (optional)';

/**
 * 校验 `--dynamic-data-type`。省略返回 undefined（请求体里不带该字段，与旧行为逐字节一致）。
 * 大小写不敏感；不是 TAVV / DAVV 在发请求前报错。
 */
export function parseDynamicDataType(raw: unknown): DynamicDataType | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toUpperCase();
  if ((DYNAMIC_DATA_TYPES as readonly string[]).includes(value)) {
    return value as DynamicDataType;
  }
  throw new CliError(
    'PARAM_INVALID',
    `Invalid --dynamic-data-type "${String(raw)}". Expected TAVV (cryptogram, default) or DAVV (3-digit dynamic CVV).`,
  );
}

/**
 * 文本输出里展示动态数据的那一行：DAVV 显示动态 CVV，其余（含旧响应没有该字段）显示 TAVV cryptogram。
 */
export function dynamicDataLine(
  nt: Record<string, unknown>,
): [label: string, value: string] {
  if (nt.dynamic_data_type === 'DAVV') {
    return ['Dynamic CVV (DAVV)', String(nt.cvv || '')];
  }
  return ['Cryptogram (TAVV)', String(nt.cryptogram || '')];
}

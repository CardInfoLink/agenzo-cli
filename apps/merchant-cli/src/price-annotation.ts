import { Command } from 'commander';
import { CliError } from '@agenzo/cli-core';
import type { FlagSchema } from './verb-schema';

/**
 * 价格批注（原价 / 优惠金额）—— 四个结算入口共用的 flag 声明、注册与 body 透传。
 *
 * 语义（与 platform `app/core/price_annotation.py` 同源）：**纯记录字段**。平台把它落在
 * 自己的 MongoDB（统一流水 `ap_upi_transactions` + 订单 `auth_snapshot`）并在响应 /
 * 订单详情里回显，但**绝不**发给收单网关（evo-cli / EVO HTTP 直连都看不到），也**绝不**
 * 参与扣款金额的推导或「实扣额 == 锁单权威价」那道核验 —— 结算金额仍只取订单锁单落库的
 * 权威价与令牌铸造时冻结的金额。
 *
 * 收敛到一处的理由：这两个 flag 要同时出现在 `hotel-redaug pay-order`、
 * `flight-flink pay-order`、`flight-flink change-pay`、`ride-elife pay-order` 上。四处各写
 * 一遍描述与解析，必然漂移成四种说法（`payment-token-id` 的描述已经踩过这个坑）。
 */

const ORIGINAL_DESCRIPTION =
  'Original (pre-discount) price in integer cents. Optional, RECORD-ONLY: stored on our own ' +
  'order / charge record and echoed back in the order detail, never sent to the acquiring ' +
  'gateway and never used to derive or validate the amount charged (that always comes from the ' +
  "order's locked authoritative price).";

const DISCOUNT_DESCRIPTION =
  'Discount amount in integer cents. Optional, RECORD-ONLY: same semantics as ' +
  '--original-amount-cents.';

/** `verb-schema.ts` 用的 flag 声明片段（展开进各 verb 的 `flags`）。 */
export const PRICE_ANNOTATION_FLAGS: Record<string, FlagSchema> = {
  'original-amount-cents': {
    type: 'int',
    required: false,
    description: ORIGINAL_DESCRIPTION,
    constraints: 'non-negative integer cents',
  },
  'discount-amount-cents': {
    type: 'int',
    required: false,
    description: DISCOUNT_DESCRIPTION,
    constraints: 'non-negative integer cents',
  },
};

/** 给一个 commander 命令挂上两个 option（链式返回，便于接在既有 `.option()` 之后）。 */
export function withPriceAnnotationOptions(cmd: Command): Command {
  return cmd
    .option('--original-amount-cents <cents>', ORIGINAL_DESCRIPTION)
    .option('--discount-amount-cents <cents>', DISCOUNT_DESCRIPTION);
}

/**
 * 把批注写进请求 body（只在 flag 真的出现时写键）。
 *
 * 本地就把非整数 / 负数挡成 `PARAM_INVALID`，不让一个纯记录字段的格式错误变成 422 往返。
 * `0` 是合法取值（优惠 0 = 明确声明「这单没有优惠」），所以判据是 `< 0` 而非 `< 1`，
 * 且用 present 判断（`!== undefined`）而非真值判断 —— 真值判断会把 `0` 折叠成「没给」。
 */
export function applyPriceAnnotation(
  body: Record<string, unknown>,
  opts: Record<string, unknown>,
): void {
  const mappings = [
    ['--original-amount-cents', 'originalAmountCents', 'original_amount_cents'],
    ['--discount-amount-cents', 'discountAmountCents', 'discount_amount_cents'],
  ] as const;

  for (const [flag, optKey, bodyKey] of mappings) {
    const raw = opts[optKey] as string | number | undefined;
    if (raw === undefined) continue;
    const cents = Number(raw);
    if (!Number.isInteger(cents) || cents < 0) {
      throw new CliError(
        'PARAM_INVALID',
        `Invalid ${flag} "${raw}". Expected a non-negative integer number of cents (e.g. 10000 for 100.00).`,
      );
    }
    body[bodyKey] = cents;
  }
}

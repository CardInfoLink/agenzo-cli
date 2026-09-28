import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
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
import { resolveIdempotencyKey } from '../idempotency.js';
import { MEMBER_OPTION_DESCRIPTION, memberIdOf } from '../member.js';
import { attachSchemaHelp, ordersPayBatchSchema } from '../verb-schema.js';
// 复用打车 watch 模块导出的 NDJSON 写行 / 真实定时器 / 秒数解析（与 pay-order.ts 同源）。
import { ndjsonWriteLine, realSleep, resolveSeconds } from '../ride-elife/watch.js';

// ============================================================
// Response types（后端 pay-batch 契约：成功体 / 3DS 挑战体）
// ============================================================

/** 聚合结算里单笔订单的最终结果（逐单确认后：成功 / 退款 / 失败）。 */
export interface PayBatchOrderResult {
  order_id: string;
  /** 该订单所属领域（hotel / flight / ride），逐单上游确认按此分派。 */
  domain?: string;
  /** confirmed（上游确认成功）| refunded（确认失败已退款）| failed。 */
  status: string;
  /** 该订单的权威金额（十进制币种单位，非最小单位）。 */
  amount?: number;
  /** 确认失败时按该订单金额退款的金额。 */
  refunded_amount?: number;
  [key: string]: unknown;
}

/**
 * `POST /orders/pay-batch` 的返回体。同一形状承载三种结果：
 * - 成功体：`status ∈ {settled, partially_settled}`，携 `total_amount`/`currency`/`per_order[]`
 *   （逐单项 `{order_id, domain, status, amount, refunded_amount}`）；
 * - 3DS 挑战体（轨 B EVO 强制认证）：`status == "AUTHENTICATION_REQUIRED"`，携 `three_ds_url`/`merchant_trans_id`/`amount`；
 * - 失败终态：`status == "failed"`。
 * CLI 是薄透传层，原样透出后端字段，不做业务判定。逐单列表键名 `per_order`（含 `domain`）与
 * 后端 `_build_result_body` / 编排层 `trip-aggregate.json`（`$.per_order`）跨仓契约一致。
 */
export interface PayBatchResponse {
  payment_group_id: string;
  /** settled | partially_settled | failed | AUTHENTICATION_REQUIRED。 */
  status: string;
  currency?: string;
  /** 合计总额 = 各订单权威价之和（后端计算，调用方不传各订单金额）。 */
  total_amount?: number;
  per_order?: PayBatchOrderResult[];
  // ---- 3DS 挑战体专有字段 ----
  three_ds_url?: string;
  merchant_trans_id?: string;
  /** 挑战金额（= 合计总额）。 */
  amount?: number;
  [key: string]: unknown;
}

// ============================================================
// Constants
// ============================================================

/** `--watch` 轮询间隔默认值（秒）。 */
export const DEFAULT_PAY_BATCH_WATCH_INTERVAL_SECONDS = 5;
/** `--watch` 轮询超时默认值（秒）。 */
export const DEFAULT_PAY_BATCH_WATCH_TIMEOUT_SECONDS = 300;

/**
 * 聚合支付的终态集合（对齐 checkout-cart plan 的 `poll` 步
 * `until: batch.status in [settled, partially_settled, failed]`）。大小写敏感，
 * 必须与后端返回的 `status` 字面量一致。`AUTHENTICATION_REQUIRED` 与授权/捕获中
 * 等状态均非终态，`--watch` 会继续轮询（幂等重放复查）。
 */
export const PAY_BATCH_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'settled',
  'partially_settled',
  'failed',
]);

// ============================================================
// Input helper：解析 --order-ids（有序，可混合 hho_/ffo_/rio_ 三域）
// ============================================================

/**
 * 解析并 shape 校验 `--order-ids`。接受两种写法（都保持顺序）：
 * - 逗号分隔：`hho_1,ffo_2,rio_3`；
 * - JSON 数组字符串：`["hho_1","ffo_2","rio_3"]`。
 *
 * 产出一个非空、去除首尾空白后的字符串列表；空值/非字符串元素/空列表 → `PARAM_INVALID`
 * （在发起任何请求前抛出）。CLI 只做"是一批非空 order_id"的最小结构校验，**不校验前缀域**
 * ——具体不可支付单 / 币种不一致 / 令牌绑定不符由后端在 4xx 里标明 order_id 与原因。
 *
 * 导出以便注册命令与后续测试直接调用。
 */
export function parseOrderIds(raw: string): string[] {
  const INVALID =
    '--order-ids must be a comma-separated list OR a JSON array of order ids '
    + '(e.g. "hho_1,ffo_2,rio_3" or ["hho_1","ffo_2"]).';

  const trimmed = raw.trim();
  let ids: string[];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CliError('PARAM_INVALID', INVALID);
    }
    if (!Array.isArray(parsed)) {
      throw new CliError('PARAM_INVALID', INVALID);
    }
    if (!parsed.every((el) => typeof el === 'string')) {
      throw new CliError('PARAM_INVALID', INVALID);
    }
    ids = (parsed as string[]).map((s) => s.trim());
  } else {
    ids = trimmed.split(',').map((s) => s.trim());
  }

  // 去除空片段（如尾随逗号），并要求至少一个有效 order_id。
  ids = ids.filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new CliError('PARAM_INVALID', INVALID);
  }
  return ids;
}

// ============================================================
// Output helper
// ============================================================

function formatPayBatch(data: PayBatchResponse): string {
  const lines: [string, string][] = [
    ['Payment group', String(data.payment_group_id ?? '-')],
    ['Status', String(data.status ?? '-')],
  ];
  if (data.total_amount != null && data.currency) {
    lines.push(['Total', `${data.total_amount} ${data.currency}`]);
  }
  // 3DS 挑战体：透出续付所需的 URL / merchantTransID / 挑战金额。
  if (data.status === 'AUTHENTICATION_REQUIRED') {
    if (data.three_ds_url) lines.push(['3DS URL', String(data.three_ds_url)]);
    if (data.merchant_trans_id) lines.push(['Merchant trans ID', String(data.merchant_trans_id)]);
    if (data.amount != null && data.currency) {
      lines.push(['Challenge amount', `${data.amount} ${data.currency}`]);
    }
  }

  const out: string[] = [Formatter.keyValue(lines)];

  const perOrder = data.per_order ?? [];
  if (perOrder.length > 0) {
    const headers = ['Order ID', 'Domain', 'Status', 'Amount', 'Refunded'];
    const rows = perOrder.map((o) => [
      String(o.order_id ?? '-'),
      String(o.domain ?? '-'),
      String(o.status ?? '-'),
      String(o.amount ?? '-'),
      String(o.refunded_amount ?? '-'),
    ]);
    out.push('', Formatter.table(headers, rows));
  }

  return out.join('\n');
}

// ============================================================
// Watch (polling) terminal predicate
// ============================================================

/**
 * 纯终态判定（导出以便单元/属性测试直接调用）：`status ∈ {settled,
 * partially_settled, failed}` 即终态。缺失/未知状态永不终态，轮询继续直到终态或超时。
 */
export function isBatchTerminal(record: unknown): boolean {
  const status = (record as { status?: unknown }).status;
  return typeof status === 'string' && PAY_BATCH_TERMINAL_STATUSES.has(status);
}

// ============================================================
// Command registration
// ============================================================

/**
 * `orders pay-batch` —— 行程聚合支付：以**一份支付凭证**对一批订单（`order_ids[]`，
 * 可混合 `hho_`/`ffo_`/`rio_` 三域）一次结算合计总额。调用 `POST /orders/pay-batch`，
 * `Idempotency-Key` 走 header，body 为
 * `{order_ids[], payment_token_id?, payment_method_id?, evo_explicit?, payment_group_id?, member_id?}`。
 *
 * - `--order-ids`（必填）：有序订单列表（逗号分隔或 JSON 数组）。金额取各订单锁单落库的
 *   权威价、由后端求和，**调用方不传各订单金额**。
 * - `--payment-token-id`（可选，轨 A）：以合计总额created、`external_transaction_id` 绑定到
 *   本次 payment_group 的网络令牌（银联/Visa 一次 passkey）。
 * - `--payment-method-id`（可选，轨 B）：EVO 绑卡（一次 3DS）。
 * - `--evo-explicit`（可选，轨 B 硬门槛）：仅在用户显式选择 EVO 时置位，透传 `evo_explicit=true`。
 * - `--payment-group-id`（可选）：调用方预生成的组号；缺省由后端生成。
 * - `--member`（可选）：归因的终端用户 member id。
 * - `--idempotency-key`（必填）：原样作为 `Idempotency-Key` header 转发；相同键 + 有序
 *   `order_ids` 重放为同一批次去重复查，不重复扣款。
 * - `--watch` / `--watch-interval` / `--watch-timeout`：NDJSON 轮询到终态
 *   （`settled` / `partially_settled` / `failed`）。
 *
 * 这是真正动钱的一步（一次卡交互覆盖整趟总额），故非 `--yes` 路径在写之前必须二次确认；
 * `--yes` 跳过。确认被拒绝映射为 `CLIENT_ABORTED`（exit 5）。单发与 `--watch` 两条路径都
 * 适用（确认只在轮询开始前发生一次）。
 *
 * 成功：exit 0，打印聚合结算结果（含逐单成功/退款金额）。
 * 业务错误：exit 1，错误码写 stderr（后端在 4xx 里标明具体 order_id 与原因）。
 * Watch 模式：每次轮询输出一行 NDJSON。
 */
export function registerOrdersPayBatchCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('pay-batch')
    .description(
      'Settle a batch of orders (may mix ride/hotel/flight) in one aggregate payment via a single payment credential',
    )
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .option(
      '--order-ids <ids>',
      'Ordered order ids to settle together — comma-separated (hho_1,ffo_2,rio_3) or a JSON array. '
      + 'May mix hho_/ffo_/rio_ domains. Amounts come from each order\'s locked authoritative price (not passed here).',
    )
    .option(
      '--payment-token-id <id>',
      '[轨 A] Network-token id minted for the aggregate total and bound to this payment_group (unionpay/visa charge path)',
    )
    .option(
      '--payment-method-id <id>',
      '[轨 B] EVO bound-card id to settle the aggregate total (one 3DS challenge)',
    )
    .option(
      '--evo-explicit',
      '[轨 B 硬门槛] Explicit opt-in to settle via the EVO bound-card rail. Set ONLY when the user explicitly chose EVO; forwarded to the body as evo_explicit=true.',
    )
    .option(
      '--payment-group-id <id>',
      'Optional caller-pre-generated payment group id; omit to let the platform generate one',
    )
    .option('--member <id>', MEMBER_OPTION_DESCRIPTION)
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    )
    .option('--watch', 'Poll until a terminal batch status or timeout (NDJSON output)', false)
    .option(
      '--watch-interval <seconds>',
      'Seconds between polls when --watch is set',
      String(DEFAULT_PAY_BATCH_WATCH_INTERVAL_SECONDS),
    )
    .option(
      '--watch-timeout <seconds>',
      'Max seconds to poll before giving up',
      String(DEFAULT_PAY_BATCH_WATCH_TIMEOUT_SECONDS),
    );

  // 挂 `--help --format json` verb schema（供工具发现 / Agent 本地读参，无需网络往返）。
  attachSchemaHelp(cmd, ordersPayBatchSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // 必填 + shape 校验：在发起任何请求前完成 → PARAM_INVALID。
    const orderIds = parseOrderIds(need(opts.orderIds as string | undefined, 'order-ids'));

    // 幂等键解析：--yes 下缺失即硬错误（在任何请求前抛出）。
    const idempotencyKey = await resolveIdempotencyKey(opts.idempotencyKey as string | undefined, {
      yes: isYes,
      commandPath: 'orders pay-batch',
    });

    // Watch 参数
    const watchEnabled = Boolean(opts.watch);
    const watchInterval = resolveSeconds(opts.watchInterval as string, DEFAULT_PAY_BATCH_WATCH_INTERVAL_SECONDS);
    const watchTimeout = resolveSeconds(opts.watchTimeout as string, DEFAULT_PAY_BATCH_WATCH_TIMEOUT_SECONDS);

    // Body 构造（薄透传）：order_ids 必带；凭证 / evo_explicit / group / member 仅在提供时带上。
    const body: Record<string, unknown> = { order_ids: orderIds };
    if (opts.paymentTokenId !== undefined) body.payment_token_id = opts.paymentTokenId as string;
    if (opts.paymentMethodId !== undefined) body.payment_method_id = opts.paymentMethodId as string;
    // 显式 EVO 选择信号：仅在置位时透传 evo_explicit=true；缺省不发（后端默认 false）。
    if (opts.evoExplicit) body.evo_explicit = true;
    if (opts.paymentGroupId !== undefined) body.payment_group_id = opts.paymentGroupId as string;
    // 归因标签：仅在显式传了非空 --member 时写入，缺省保持无归属。
    const member = memberIdOf(opts);
    if (member !== undefined) body.member_id = member;

    // 写前二次确认（除非 --yes）。这是真正动钱的一步：一次卡交互覆盖整趟合计总额
    // （银联/Visa 一次 passkey 或 EVO 一次 3DS）。合计总额由后端按权威价求和，CLI 端
    // 未知，故确认话术只声明订单笔数。提示走 stderr；拒绝映射 CLIENT_ABORTED（exit 5）。
    // 单发与 --watch 都适用（确认只在轮询开始前发生一次）。
    if (!isYes) {
      const confirmed = await confirm({
        message:
          `Settle ${orderIds.length} order(s) in one aggregate payment? `
          + 'This moves money — a single charge covers the authoritative total of all listed orders '
          + '(banks/EVO see one transaction).',
        default: false,
      });
      if (!confirmed) {
        throw new CliError('CLIENT_ABORTED', 'Aggregate payment aborted by user.');
      }
    }

    const path = '/orders/pay-batch';
    const headers = { 'Idempotency-Key': idempotencyKey };
    const auth = { type: 'api-key' as const, key: apiKey };

    if (!watchEnabled) {
      // 单发模式
      const spinner = format === 'json' ? null : createSpinner('Settling order batch...');

      const result = await deps.apiClient.post<PayBatchResponse>(path, auth, body, headers);

      spinner?.stop();

      if (!result.success) {
        throw CliError.fromApi(result, { auth: 'api-key' });
      }

      const data = result.data;
      const configManager = new ConfigManager();
      const commandResult: CommandResult<PayBatchResponse> = {
        data,
        text: () => formatPayBatch(data),
      };

      await renderWithContext(commandResult, { format }, configManager);
    } else {
      // Watch 模式：幂等重放复查同一批次，逐次输出 NDJSON，直到终态或超时。
      const deadline = Date.now() + watchTimeout * 1000;
      let lastRecord: unknown = null;

      for (;;) {
        const result = await deps.apiClient.post<PayBatchResponse>(path, auth, body, headers);

        if (result.success) {
          const data = result.data;
          lastRecord = data;
          ndjsonWriteLine(data);

          // 终态（settled / partially_settled / failed）→ 停止。非终态（授权/捕获中、
          // AUTHENTICATION_REQUIRED 等）→ 继续轮询：用户在 3DS 页外带完成认证后，
          // 后续一次幂等重放即结算。
          if (isBatchTerminal(data)) {
            return;
          }
        } else {
          // 业务错误（不可支付单 / 币种不一致 / 令牌绑定不符等）→ 直接 exit 1。
          throw CliError.fromApi(result, { auth: 'api-key' });
        }

        // 超时检查：下一次轮询将越过截止时间则收尾。
        if (Date.now() + watchInterval * 1000 >= deadline) {
          const timeoutLine = {
            watch_status: 'timeout',
            message: `Polling stopped after ${watchTimeout}s without reaching a terminal batch status.`,
            last_status: lastRecord,
          };
          ndjsonWriteLine(timeoutLine);
          return;
        }

        await realSleep(watchInterval * 1000);
      }
    }
  });
}

// ============================================================
// Local input helper
// ============================================================

/** 必填标量取值：缺失即 PARAM_INVALID（在任何请求前抛出）。 */
function need(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new CliError('PARAM_INVALID', `Missing required --${flag}.`);
  }
  return value;
}

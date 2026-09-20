import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  createSpinner,
  resolveFormat,
  notify,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult, OutputFormat } from '@agenzo/cli-core';
import type { PaymentMethod } from '../types/api.js';
import { attachSchemaHelp, pmAddSchema } from '../verb-schema.js';

// ============================================================
// Constants
// ============================================================

// Hosted binding: the cardholder enters the card and completes verification in
// the browser (the hosted page itself splits Visa vs Mastercard), so the CLI
// polls patiently. The backend flips the PM to EXPIRED if it is not completed
// in time.
const DROPIN_POLL_INTERVAL_MS = 5000;
const DROPIN_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Backend writes one of these into PaymentMethod.status when the verification
// flow reaches a final state. We stop polling on any of them.
const TERMINAL_STATUSES = new Set(['ACTIVE', 'FAILED', 'EXPIRED']);

type AddDeps = { apiClient: ApiClient };

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-methods add` — add a payment method.
 *
 * Two paths, selected via `--payment-brand`:
 *
 *  - **omitted (default): hosted binding.** The CLI never collects card details.
 *    It opens a hosted binding session (POST /payment-methods/binding-session),
 *    prints the returned `link_url`, and polls verification/status until ACTIVE /
 *    FAILED / EXPIRED / 30-minute timeout. The cardholder enters the card and
 *    completes verification in the browser; the hosted page itself detects the
 *    card brand and runs the matching rail — Visa (VTS self-mint + Payment
 *    Passkey) or Mastercard/others (EVO Drop-in) — with both landing on the same
 *    PM. This mirrors H5: one card-entry surface, brand split inside the page.
 *    EVO and Visa are no longer separate CLI brands.
 *  - **`unionpay`: UPI Agent Pay enrollment.** POSTs /payment-methods/create with
 *    `payment_brand=unionpay`, prints the returned `enroll_url` for the user to
 *    complete card binding in a browser, then polls until ACTIVE / FAILED.
 *    Unchanged.
 */
export function registerAddCommand(parent: Command, deps: AddDeps): void {
  const cmd = parent
    .command('add')
    .description('Add a payment method via the hosted binding page (or UnionPay enrollment)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--type <type>', 'Payment method type (default: card)', 'card')
    .option(
      '--payment-brand <brand>',
      'Payment brand: "visa", "mastercard", or omitted all open the SAME hosted binding page (same link_url) — the page detects the card brand and runs the matching rail (Visa VTS + passkey, or Mastercard EVO). Pass "unionpay" for UnionPay Agent Pay enrollment (separate flow).',
    )
    .option(
      '--member <id>',
      'End-user member id this card belongs to. Required when --payment-brand unionpay; optional (but recommended) for hosted binding so the card is scoped to the member and surfaces in list --member <id>',
    )
    .option(
      '--email <email>',
      'Cardholder email. Used as the hosted binding session reference (the hosted page emails the secure link there) and as the UnionPay enrollment email.',
    )
    .option(
      '--return-url <url>',
      'Optional front-end redirect URL after UPI enrollment completes. Only applicable to --payment-brand unionpay. If not provided, the caller determines post-enrollment navigation.',
    );

  attachSchemaHelp(cmd, pmAddSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    // --payment-brand 取值：`visa` / `mastercard` / 省略 三者走**同一条**托管绑卡链路
    // （同一个 /payment-methods/binding-session，同一 link_url）——托管页自己按 PAN 分流
    // 走 Visa（VTS 自铸 + passkey）或万事达（EVO Drop-in），brand 只是可选提示、不改变 URL。
    // `unionpay` 是独立入口（UPI Agent Pay 报名）。CLI 不再本地收卡、不再本地判品牌。
    const rawBrand = opts.paymentBrand as string | undefined;
    const paymentBrand = (rawBrand ?? '').toLowerCase();
    const HOSTED_BRANDS = ['visa', 'mastercard'];
    if (paymentBrand && paymentBrand !== 'unionpay' && !HOSTED_BRANDS.includes(paymentBrand)) {
      throw new CliError(
        'PARAM_INVALID',
        `Unknown --payment-brand "${rawBrand}". Use "visa" or "mastercard" (both open the ` +
          `same hosted binding page), omit it (same page, auto-detects brand), or pass ` +
          `"unionpay" for UnionPay enrollment.`,
      );
    }

    if (paymentBrand === 'unionpay') {
      await handleUnionpayPaymentBrand(deps, opts, format);
      return;
    }

    // visa / mastercard / 省略 → 同一条托管绑卡链路。
    await handleHostedBinding(deps, opts, format);
  });
}

// ============================================================
// Hosted binding (default): open the hosted page, poll to terminal status
// ============================================================

/**
 * 托管绑卡（默认路径，EVO + Visa 合一）。
 *
 * CLI 不再本地收卡：调 ``POST /payment-methods/binding-session`` 开一次托管会话，拿到一条
 * ``link_url`` 打印给用户；持卡人在浏览器里打开、录卡号并完成验证。**托管页自己按卡号品牌
 * 分流** —— Visa 走 VTS 自铸 + Payment Passkey，Mastercard 等走 EVO Drop-in —— 两条轨都落在
 * 同一条 pm 上。CLI 随后按 ``verification/status`` 轮询这条 pm 到 ACTIVE / FAILED / 超时。
 *
 * 与 H5 完全一致：H5 也是一个统一收卡入口、页面内部按品牌分两条轨；CLI 把「录卡 + 分流」整个
 * 交给同一个托管页，自己只负责发起会话与轮询终态。卡号从不经过 CLI 或调用方系统。
 */
async function handleHostedBinding(
  deps: AddDeps,
  opts: Record<string, unknown>,
  format: OutputFormat,
): Promise<void> {
  const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
    message: 'API Key:',
    type: 'password',
  });

  const email = await PromptEngine.resolveInput(opts.email as string | undefined, {
    message: 'Email (the hosted binding link is sent here):',
  });

  // --member 不在 CLI 侧强制：归属是否必需由服务端判定，CLI 只透传（与其余绑卡入口一致）。
  const member = ((opts.member as string | undefined) ?? '').trim();

  const configManager = new ConfigManager();

  // 开托管绑卡会话。端点是品牌中立名 /payment-methods/binding-session（历史别名
  // /payment-methods/visa/binding-session 仍可用，但 CLI 走中立名）。
  const sessionResult = await deps.apiClient.post<PaymentMethod>(
    '/payment-methods/binding-session',
    { type: 'api-key', key: apiKey },
    { email, ...(member ? { member_id: member } : {}) },
  );

  if (!sessionResult.success) {
    throw CliError.fromApi(sessionResult, { auth: 'api-key' });
  }

  const pm = sessionResult.data;

  notify(format, 'success', 'Hosted binding session created');

  const createdResult: CommandResult<PaymentMethod> = {
    data: pm,
    text: () =>
      Formatter.keyValue([
        ['ID', pm.id],
        ['Status', pm.status],
        ['Link URL', pm.link_url ?? '-'],
      ]),
  };
  await renderWithContext(createdResult, { format }, configManager);

  notify(
    format,
    'info',
    'Open the Link URL in a browser to enter the card and complete verification. Waiting for result...',
  );

  // 轮询到终态。托管页两条轨（Visa 自铸 / EVO Drop-in）都把结果落在这条 pm 上，
  // 所以无论用户绑的是哪种卡，这一条 verification/status 都会收敛。
  const finalPm = await pollVerificationStatus(deps.apiClient, apiKey, pm.id, {
    intervalMs: DROPIN_POLL_INTERVAL_MS,
    timeoutMs: DROPIN_POLL_TIMEOUT_MS,
  });

  if (finalPm.status === 'ACTIVE') {
    notify(format, 'success', 'Payment method activated');
    const activated: CommandResult<PaymentMethod> = {
      data: finalPm,
      text: () =>
        Formatter.keyValue([
          ['PM ID', finalPm.id],
          ['Brand', finalPm.brand ?? '-'],
          ['First 6', finalPm.first6 ?? '-'],
          ['Last 4', finalPm.last4 ?? '-'],
          ['Status', finalPm.status],
        ]),
    };
    await renderWithContext(activated, { format }, configManager);
    return;
  }

  if (finalPm.status === 'FAILED') {
    notify(format, 'error', 'Failed to add payment method');
    await renderPmId(finalPm.id, format, configManager);
    process.exitCode = 1;
    return;
  }

  if (finalPm.status === 'EXPIRED') {
    notify(format, 'error', 'The binding session expired before the card was added');
    await renderPmId(finalPm.id, format, configManager);
    process.exitCode = 1;
    return;
  }

  notify(
    format,
    'info',
    `Verification did not complete within 30 minutes. Check status with: agenzo-token-cli payment-methods get ${pm.id} --api-key <your_key>`,
  );
  await renderPmId(pm.id, format, configManager);
  process.exitCode = 1;
}

// ============================================================
// UnionPay payment brand (enrollment: POST create(payment_brand=unionpay) + print enroll_url)
// ============================================================

/**
 * UnionPay payment brand: POST /payment-methods/create with `payment_brand=unionpay` +
 * `member_id`, print the returned `enroll_url` for the user to open in a
 * browser to complete card binding, then return immediately.
 *
 * No idempotency key is needed (unlike evo manual mode) — unionpay binding is
 * a UPI-side enrollment, not a card charge/verification attempt. No polling
 * happens here: the enrollment result arrives asynchronously via webhook, and
 * terminal-state polling (if any) is done by the orchestrator via
 * `payment-methods list`/`get`, not the CLI.
 */
async function handleUnionpayPaymentBrand(
  deps: AddDeps,
  opts: Record<string, unknown>,
  format: OutputFormat,
): Promise<void> {
  const isYes = Boolean(opts.yes);

  // --member 一律不在 CLI 侧强制。归属是否必需由服务端判定（UnionPay 侧
  // consumer_identity_value 由 member_id 派生，缺失会被平台以 INVALID_REQUEST 拒绝），
  // CLI 只负责透传：把服务端规则复制到客户端会造成两处规则漂移，也让"某些接入方
  // 就是不需要归属"这种情况无从表达。非交互模式下缺失就直接发请求，让平台报错。
  const memberInput = ((opts.member as string | undefined) ?? '').trim();
  let member = memberInput;
  if (!member && !isYes) {
    member = (
      await PromptEngine.resolveInput(undefined, {
        message: 'Member ID (end-user identity this card belongs to, optional):',
      })
    ).trim();
  }

  const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
    message: 'API Key:',
    type: 'password',
  });

  const email = await PromptEngine.resolveInput(opts.email as string | undefined, {
    message: 'Email:',
  });

  const result = await deps.apiClient.post<PaymentMethod>(
    '/payment-methods/create',
    { type: 'api-key', key: apiKey },
    {
      type: 'card',
      payment_brand: 'unionpay',
      ...(member ? { member_id: member } : {}),
      email,
      ...(opts.returnUrl ? { return_url: String(opts.returnUrl) } : {}),
    },
  );

  if (!result.success) {
    throw CliError.fromApi(result, { auth: 'api-key' });
  }

  const pm = result.data;

  notify(format, 'success', 'Card binding initiated');

  const createdResult: CommandResult<PaymentMethod> = {
    data: pm,
    text: () =>
      Formatter.keyValue([
        ['ID', pm.id],
        ['Status', pm.status],
        ['Enroll URL', pm.enroll_url ?? '-'],
        ['Correlation ID', pm.correlation_id ?? '-'],
      ]),
  };

  const configManager = new ConfigManager();
  await renderWithContext(createdResult, { format }, configManager);

  notify(
    format,
    'info',
    'Open the Enroll URL in a browser to complete card binding. Waiting for result...',
  );

  // Poll GET /payment-methods/{id} every 5s, up to 60s, waiting for ACTIVE/FAILED.
  const UNIONPAY_POLL_INTERVAL_MS = 5000;
  const UNIONPAY_POLL_TIMEOUT_MS = 60_000;
  const startTime = Date.now();

  const spinner = format !== 'json' ? createSpinner('Waiting for card binding result...') : null;

  while (Date.now() - startTime < UNIONPAY_POLL_TIMEOUT_MS) {
    await sleep(UNIONPAY_POLL_INTERVAL_MS);

    const pollResult = await deps.apiClient.get<PaymentMethod>(
      `/payment-methods/${pm.id}`,
      { type: 'api-key', key: apiKey },
    );

    if (pollResult.success) {
      const status = pollResult.data.status;
      if (status === 'ACTIVE') {
        spinner?.stop();
        notify(format, 'success', 'Payment method activated');
        const activatedPm = pollResult.data;
        const activatedResult: CommandResult<PaymentMethod> = {
          data: activatedPm,
          text: () => {
            const lines: [string, string][] = [
              ['ID', activatedPm.id],
              ['Type', activatedPm.type ?? 'card'],
              ['Status', activatedPm.status],
            ];
            if (activatedPm.brand) lines.push(['Brand', activatedPm.brand]);
            if (activatedPm.first6) lines.push(['First 6', activatedPm.first6]);
            if (activatedPm.last4) lines.push(['Last 4', activatedPm.last4]);
            return Formatter.keyValue(lines);
          },
        };
        await renderWithContext(activatedResult, { format }, configManager);
        return;
      }
      if (status === 'FAILED') {
        spinner?.stop('error', 'Card binding failed.');
        return;
      }
    }
    // Still PENDING — continue polling
  }

  spinner?.stop('info', 'Timed out waiting for card binding result. Check status later with: payment-methods get ' + pm.id);
}


/** Render `{ id }` as the terminal payload (PM ID line in table, JSON in json). */
async function renderPmId(
  id: string,
  format: OutputFormat,
  configManager: ConfigManager,
): Promise<void> {
  const result: CommandResult<{ id: string }> = {
    data: { id },
    text: () => Formatter.keyValue([['PM ID', id]]),
  };
  await renderWithContext(result, { format }, configManager);
}

// ============================================================
// Polling helpers
// ============================================================
interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Poll GET /payment-methods/verification/status?payment_method_id=<id> at
 * `intervalMs` until the PM reaches a terminal status (ACTIVE / FAILED /
 * EXPIRED) or `timeoutMs` elapses (dropin mode).
 *
 * Returns the final PaymentMethod on a terminal status, or
 * `{ id, status: 'PENDING' }` on timeout so callers can branch on the final
 * status uniformly. Transient poll errors are ignored (next tick retries).
 */
async function pollVerificationStatus(
  apiClient: ApiClient,
  apiKey: string,
  pmId: string,
  options: PollOptions,
): Promise<PaymentMethod> {
  const startTime = Date.now();

  while (Date.now() - startTime < options.timeoutMs) {
    const result = await apiClient.get<PaymentMethod>(
      '/payment-methods/verification/status',
      { type: 'api-key', key: apiKey },
      { payment_method_id: pmId },
    );

    if (result.success && TERMINAL_STATUSES.has(result.data.status)) {
      return result.data;
    }

    await sleep(options.intervalMs);
  }

  return { id: pmId, status: 'PENDING' } as PaymentMethod;
}

/** Simple async sleep utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

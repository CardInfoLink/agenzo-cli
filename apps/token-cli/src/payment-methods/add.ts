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
  IdempotencyKeyRequiredError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult, OutputFormat } from '@agenzo/cli-core';
import type { DropinCreateResponse, PaymentMethod } from '../types/api.js';
import { collectPaymentMethodParams } from './prompts.js';
import { attachSchemaHelp, pmAddSchema } from '../verb-schema.js';

// ============================================================
// Constants
// ============================================================

// Manual mode (3DS via email): the user clicks the magic link in their
// inbox, so polling is short and tight.
const MANUAL_POLL_INTERVAL_MS = 3000;
const MANUAL_POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Drop-in mode (v3): the add-payment-method form is rendered by the Drop-in
// SDK inside the developer's own front-end, so the operator may need longer
// to finish in the browser. The backend flips the PM to EXPIRED if the user
// does not complete in time.
const DROPIN_POLL_INTERVAL_MS = 5000;
const DROPIN_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Backend writes one of these into PaymentMethod.status when the verification
// flow reaches a final state. We stop polling on any of them. EXPIRED only
// ever applies to dropin PMs (manual PMs never expire server-side).
const TERMINAL_STATUSES = new Set(['ACTIVE', 'FAILED', 'EXPIRED']);

type AddDeps = { apiClient: ApiClient };

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-methods add` — add a payment method (§3.4.0.1).
 *
 * Two modes, selected via `--mode`:
 *
 *  - `manual` (default): the CLI collects card details (--email / --card-number
 *    / --expiry / --cvv), POSTs /payment-methods/create, then polls 3DS
 *    verification until ACTIVE / FAILED / 15-minute timeout.
 *  - `dropin`: the CLI mints a Drop-in session (POST /payment-methods/dropin/create
 *    with the developer email), prints the session id so the caller can render
 *    the add-payment UI in their own front-end via the Drop-in SDK, then polls
 *    the same verification/status endpoint until ACTIVE / FAILED / EXPIRED /
 *    30-minute timeout. No card details / idempotency key are needed.
 *
 * Orthogonal to `--mode` is `--payment-brand`, selecting the payment brand:
 *
 *  - `evo` (default): the existing Evo 3DS binding flow above, fully unchanged.
 *  - `unionpay`: dispatches to UPI Agent Pay enrollment. Requires `--member <id>`
 *    (the end-user identity the card is bound to). POSTs /payment-methods/create
 *    with `payment_brand=unionpay`, prints the returned `enroll_url` for the user to open
 *    in a browser to complete card binding, then exits immediately — the CLI
 *    does not poll for unionpay (the async result arrives via webhook; polling
 *    for terminal state is done by the orchestrator, not the CLI).
 */
export function registerAddCommand(parent: Command, deps: AddDeps): void {
  const cmd = parent
    .command('add')
    .description('Add a payment method (manual 3DS or Drop-in session)')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--type <type>', 'Payment method type (default: card)', 'card')
    .option(
      '--payment-brand <brand>',
      'Payment brand: "evo" (default; existing 3DS/Drop-in binding) or "unionpay" (UPI Agent Pay enrollment)',
      'evo',
    )
    .option(
      '--member <id>',
      'End-user member id (required when --payment-brand unionpay; identifies which end-user this card belongs to)',
    )
    .option(
      '--mode <mode>',
      'Add mode: "manual" (default; CLI collects card details and polls 3DS) or "dropin" (mint a Drop-in session and poll until the user finishes adding the payment method in the browser)',
      'manual',
    )
    .option(
      '--email <email>',
      'Manual mode: email for 3DS verification. Dropin mode: email used as the Drop-in session reference.',
    )
    .option('--card-number <number>', 'Card number (manual mode only)')
    .option('--expiry <mmyy>', 'Expiry date (MMYY format) (manual mode only)')
    .option('--cvv <cvv>', 'Card CVV (manual mode only)')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header (manual mode only)',
    )
    .option(
      '--no-poll',
      'Dropin mode: mint the session, print it, and exit immediately without polling verification status (for server/SDK-driven flows where the front-end completes the binding)',
    )
    .option(
      '--return-url <url>',
      'Optional front-end redirect URL after UPI enrollment completes. Only applicable to --payment-brand unionpay. If not provided, the caller determines post-enrollment navigation.',
    );

  attachSchemaHelp(cmd, pmAddSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const paymentBrand = String(opts.paymentBrand ?? 'evo').toLowerCase();
    if (paymentBrand !== 'evo' && paymentBrand !== 'unionpay') {
      throw new CliError(
        'PARAM_INVALID',
        `Unknown --payment-brand "${opts.paymentBrand}". Expected "evo" or "unionpay".`,
      );
    }

    if (paymentBrand === 'unionpay') {
      await handleUnionpayPaymentBrand(deps, opts, format);
      return;
    }

    const mode = String(opts.mode ?? 'manual').toLowerCase();
    if (mode !== 'manual' && mode !== 'dropin') {
      throw new CliError(
        'PARAM_INVALID',
        `Unknown --mode "${opts.mode}". Expected "manual" or "dropin".`,
      );
    }

    if (mode === 'dropin') {
      await handleDropinMode(deps, opts, format);
      return;
    }

    await handleManualMode(deps, opts, format, isYes);
  });
}

// ============================================================
// Manual mode (collect card details + 3DS polling)
// ============================================================

/**
 * Manual mode: collect card details, POST /payment-methods/create, then poll
 * 3DS verification status until ACTIVE / FAILED / 15-minute timeout.
 */
async function handleManualMode(
  deps: AddDeps,
  opts: Record<string, unknown>,
  format: OutputFormat,
  isYes: boolean,
): Promise<void> {
  // --- Resolve API key ---
  const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
    message: 'API Key:',
    type: 'password',
  });

  // --- Resolve payment method type ---
  const type = (opts.type as string) || 'card';

  // --- Collect card params via PromptEngine ---
  const flags: Record<string, string | undefined> = {
    email: opts.email as string | undefined,
    cardNumber: opts.cardNumber as string | undefined,
    expiry: opts.expiry as string | undefined,
    cvv: opts.cvv as string | undefined,
  };
  const params = await collectPaymentMethodParams(type, flags);

  // --- Idempotency key (required for write, Requirement 6.3) ---
  let idempotencyKey = opts.idempotencyKey as string | undefined;
  if (!idempotencyKey) {
    if (isYes) {
      throw new IdempotencyKeyRequiredError('payment-methods add');
    }
    idempotencyKey = await PromptEngine.resolveInput(undefined, {
      message: 'Idempotency key (unique per write, for safe retry):',
      validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
    });
  }

  const extraHeaders: Record<string, string> = {
    'Idempotency-Key': idempotencyKey,
  };

  // --- POST /payment-methods/create ---
  const result = await deps.apiClient.post<PaymentMethod>(
    '/payment-methods/create',
    { type: 'api-key', key: apiKey },
    params,
    extraHeaders,
  );

  if (!result.success) {
    throw CliError.fromApi(result, { auth: 'api-key' });
  }

  const pm = result.data;

  // --- Output: created state ---
  notify(format, 'success', 'Payment method created');

  const createdResult: CommandResult<PaymentMethod> = {
    data: pm,
    text: () => {
      const lines: [string, string][] = [
        ['ID', pm.id],
        ['Type', pm.type],
        ['Status', pm.status],
      ];
      if (pm.brand) lines.push(['Brand', pm.brand]);
      if (pm.first6) lines.push(['First 6', pm.first6]);
      if (pm.last4) lines.push(['Last 4', pm.last4]);
      return Formatter.keyValue(lines);
    },
  };

  const configManager = new ConfigManager();
  await renderWithContext(createdResult, { format }, configManager);

  // Hint about 3DS (after keyValue output)
  notify(format, 'info', 'Complete 3DS verification via email to activate');

  // --- 3DS polling (only for type=card and PENDING status) ---
  if (type === 'card' && pm.status === 'PENDING') {
    const finalStatus = await poll3dsVerification(deps.apiClient, apiKey, pm.id, format);

    if (finalStatus === 'ACTIVE') {
      // Fetch the updated payment method for full details
      const getResult = await deps.apiClient.get<PaymentMethod>(
        `/payment-methods/${pm.id}`,
        { type: 'api-key', key: apiKey },
      );

      if (getResult.success) {
        const activatedPm = getResult.data;
        notify(format, 'success', 'Payment method activated');

        const activatedResult: CommandResult<PaymentMethod> = {
          data: activatedPm,
          text: () => {
            const lines: [string, string][] = [
              ['ID', activatedPm.id],
              ['Type', activatedPm.type],
              ['Status', activatedPm.status],
            ];
            if (activatedPm.brand) lines.push(['Brand', activatedPm.brand]);
            if (activatedPm.first6) lines.push(['First 6', activatedPm.first6]);
            if (activatedPm.last4) lines.push(['Last 4', activatedPm.last4]);
            return Formatter.keyValue(lines);
          },
        };

        await renderWithContext(activatedResult, { format }, configManager);
      } else {
        // 3DS already reported ACTIVE, but the follow-up detail GET failed.
        // Emit a degraded terminal state from what we already know (the
        // create response + known-ACTIVE status) rather than exiting silently.
        notify(format, 'success', 'Payment method activated');

        const degraded: PaymentMethod = { ...pm, status: 'ACTIVE' };
        const degradedResult: CommandResult<PaymentMethod> = {
          data: degraded,
          text: () => {
            const lines: [string, string][] = [
              ['ID', degraded.id],
              ['Type', degraded.type],
              ['Status', degraded.status],
            ];
            if (degraded.brand) lines.push(['Brand', degraded.brand]);
            if (degraded.first6) lines.push(['First 6', degraded.first6]);
            if (degraded.last4) lines.push(['Last 4', degraded.last4]);
            return Formatter.keyValue(lines);
          },
        };

        await renderWithContext(degradedResult, { format }, configManager);
      }
    } else if (finalStatus === 'FAILED') {
      notify(format, 'error', '3DS verification failed');
    } else if (finalStatus === 'TIMEOUT') {
      notify(
        format,
        'info',
        `Verification timed out (15 min). Check status with: agenzo-token-cli payment-methods get ${pm.id} --api-key <your_key>`,
      );
    }
  }
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

  // In --yes (non-interactive) mode, --member is required as a flag.
  let member: string;
  if (opts.member) {
    member = String(opts.member);
  } else if (isYes) {
    throw new CliError(
      'PARAM_INVALID',
      'Missing required --member <id> for --payment-brand unionpay (required in --yes mode)',
    );
  } else {
    member = await PromptEngine.resolveInput(undefined, {
      message: 'Member ID (end-user identity this card belongs to):',
      validate: (v) => v.trim().length > 0 || 'Member ID is required for --payment-brand unionpay',
    });
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
      member_id: member,
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

// ============================================================
// Drop-in mode (mint Drop-in session + poll)
// ============================================================

/**
 * Drop-in mode: mint a Drop-in session and hand the add-payment-method UI off
 * to the developer's own front-end (which embeds the Drop-in SDK using the
 * session id). The CLI then polls the same verification/status endpoint manual
 * mode uses until the PM reaches a terminal status or the 30-minute timeout.
 */
async function handleDropinMode(
  deps: AddDeps,
  opts: Record<string, unknown>,
  format: OutputFormat,
): Promise<void> {
  const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
    message: 'API Key:',
    type: 'password',
  });

  const email = await PromptEngine.resolveInput(opts.email as string | undefined, {
    message: 'Email:',
  });

  const configManager = new ConfigManager();

  // 1) Create the Drop-in session (API Key auth). The backend creates a
  // PENDING PM keyed by pm_id and mints the session for the front-end SDK.
  const sessionResult = await deps.apiClient.post<DropinCreateResponse>(
    '/payment-methods/dropin/create',
    { type: 'api-key', key: apiKey },
    { email },
  );

  if (!sessionResult.success) {
    throw CliError.fromApi(sessionResult, { auth: 'api-key' });
  }

  const session = sessionResult.data;
  const pmId = session.id;

  // 2) Print the session id so the caller can initialise the front-end SDK.
  notify(format, 'success', 'Drop-in session created');

  const createdResult: CommandResult<DropinCreateResponse> = {
    data: session,
    text: () => Formatter.keyValue([['Session ID', session.session_id || '-']]),
  };
  await renderWithContext(createdResult, { format }, configManager);

  notify(
    format,
    'info',
    'Use the Session ID to add the payment method in the browser via the Drop-in SDK',
  );

  // --no-poll: server/SDK-driven flows finish the binding in the front-end, so
  // the CLI mints + prints the session and exits immediately. The session id is
  // already on stdout (clean JSON in --format json), so the caller can parse it.
  if (opts.poll === false) {
    return;
  }

  // 3) Poll verification/status (same endpoint manual mode uses) until the PM
  // reaches a terminal status or we time out at 30 minutes.
  const finalPm = await pollVerificationStatus(deps.apiClient, apiKey, pmId, {
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
    notify(format, 'error', 'Session expired before the payment method was added');
    await renderPmId(finalPm.id, format, configManager);
    process.exitCode = 1;
    return;
  }

  // Timed out without reaching a terminal status — PM is still PENDING
  // server-side. The operator can re-run with the same email to resume
  // (PENDING dropin PMs are overwritten/reused).
  notify(
    format,
    'error',
    'Adding payment method did not complete within 30 minutes. Re-run with the same email to resume.',
  );
  await renderPmId(pmId, format, configManager);
  process.exitCode = 1;
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

/**
 * Poll GET /payment-methods/verification/status?payment_method_id=<id> every
 * 3000ms until ACTIVE, FAILED, or 15-minute timeout (manual / 3DS mode).
 *
 * Returns the terminal status: 'ACTIVE' | 'FAILED' | 'TIMEOUT'.
 */
async function poll3dsVerification(
  apiClient: ApiClient,
  apiKey: string,
  paymentMethodId: string,
  format: OutputFormat,
): Promise<'ACTIVE' | 'FAILED' | 'TIMEOUT'> {
  const startTime = Date.now();

  notify(format, 'info', 'Waiting for 3DS verification...');

  while (Date.now() - startTime < MANUAL_POLL_TIMEOUT_MS) {
    await sleep(MANUAL_POLL_INTERVAL_MS);

    const result = await apiClient.get<{ status: string }>(
      '/payment-methods/verification/status',
      { type: 'api-key', key: apiKey },
      { payment_method_id: paymentMethodId },
    );

    if (result.success) {
      const status = result.data.status;
      if (status === 'ACTIVE') {
        return 'ACTIVE';
      }
      if (status === 'FAILED') {
        return 'FAILED';
      }
      // Still PENDING — continue polling
    }
    // On API error during polling, continue trying (transient failures)
  }

  return 'TIMEOUT';
}

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

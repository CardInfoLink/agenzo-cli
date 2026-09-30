import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';

type ResumeDeps = { apiClient: ApiClient };

/** Server ChargeResult payload (amounts in integer cents). */
interface ChargeResult {
  charge_no: string;
  payment_brand: string;
  amount_cents: number;
  fee_cents: number;
  total_cents: number;
  currency: string;
  pay_status: string; // success | failed | pending | requires_action
  three_ds_url?: string;
  merchant_trans_id?: string;
  evo_trans_id?: string;
  result_code?: string | null;
  result_message?: string | null;
}

function formatCents(cents: number | undefined): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * `payments capture-resume` — confirm a token charge's passkey/3DS and settle.
 *
 * Phase 2 of an authenticated token capture (see `payments capture --authenticate`, which returns
 * pay_status=requires_action + three_ds_url for EVO/Mastercard network tokens). After the
 * cardholder completes the passkey/3DS in the browser, this queries the terminal state and settles
 * (the network-token charge is a SALE with auto-capture, so there is no separate capture leg):
 * `pay_status="success"` when captured, `"pending"` if authentication is not finished yet (retry
 * later), `"failed"` on decline. Idempotent via `charge_no` — no Idempotency-Key header needed
 * (the platform keys the outcome to the charge record). Mirrors `charge-card-resume` but hits
 * POST /pay/resume (the token /pay rail) instead of /charge/card/resume (the bare-card rail).
 *
 * Registered under the `payments` command group → `agenzo-payment-cli payments capture-resume`
 * (orchestrator tool `payment__payments__capture-resume`).
 */
export function registerCaptureResumeCommand(parent: Command, deps: ResumeDeps): void {
  const cmd = parent
    .command('capture-resume')
    .description('Confirm passkey/3DS and settle a previously authenticated token capture')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--charge-no <no>', 'Charge number from `payments capture` (chg_...)');

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const isYes = Boolean(opts.yes);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    let chargeNo = opts.chargeNo as string | undefined;
    if (!chargeNo) {
      if (isYes) {
        throw new CliError(
          'PARAM_INVALID',
          'Missing required --charge-no for payments capture-resume (required in --yes mode).',
        );
      }
      chargeNo = await PromptEngine.resolveInput(undefined, {
        message: 'Charge number (chg_...):',
        validate: (v) => v.trim().length > 0 || 'Charge number is required',
      });
    }

    const result = await deps.apiClient.post<ChargeResult>(
      '/pay/resume',
      { type: 'api-key', key: apiKey },
      { charge_no: chargeNo },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const charge = result.data;
    notify(format, 'success', 'Payment resumed');

    const commandResult: CommandResult<ChargeResult> = {
      data: charge,
      text: () =>
        Formatter.keyValue([
          ['Charge No', charge.charge_no],
          ['Status', charge.pay_status],
          ['Brand', charge.payment_brand],
          ['Amount', `${formatCents(charge.amount_cents)} ${charge.currency}`],
          ['Fee', `${formatCents(charge.fee_cents)} ${charge.currency}`],
          ['Total', `${formatCents(charge.total_cents)} ${charge.currency}`],
          ['Merchant Trans ID', charge.merchant_trans_id ?? '-'],
          ['EVO Trans ID', charge.evo_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

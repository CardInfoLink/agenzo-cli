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

/** Server CardChargeResult payload (amounts in integer cents). */
interface CardChargeResult {
  charge_no: string;
  status: string; // pending | success | failed
  amount_cents: number;
  currency: string;
  payment_brand: string;
  three_ds_url?: string;
  merchant_trans_id?: string;
  evo_trans_id?: string;
}

function formatCents(cents: number | undefined): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/**
 * `payments charge-card-resume` — confirm 3DS and capture a previously authorized card charge.
 *
 * Phase 2 of the EVO/Mastercard standalone charge (see `payments charge-card`). After the
 * cardholder completes 3DS in the browser, this confirms the authentication terminal state and
 * captures: `status="success"` on capture, `status="pending"` if 3DS is not finished yet (retry
 * later), `status="failed"` if authentication/capture failed. Idempotent via `charge_no` — no
 * Idempotency-Key header needed (the platform keys the outcome to the charge record).
 *
 * Registered under the `payments` command group → `agenzo-payment-cli payments charge-card-resume`
 * (orchestrator tool `payment__payments__charge-card-resume`).
 */
export function registerChargeCardResumeCommand(parent: Command, deps: ResumeDeps): void {
  const cmd = parent
    .command('charge-card-resume')
    .description('Confirm 3DS and capture a previously authorized card charge')
    .option('--api-key <key>', 'API Key for authentication')
    .option('--charge-no <no>', 'Charge number from charge-card (chg_...)');

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
          'Missing required --charge-no for payments charge-card-resume (required in --yes mode).',
        );
      }
      chargeNo = await PromptEngine.resolveInput(undefined, {
        message: 'Charge number (chg_...):',
        validate: (v) => v.trim().length > 0 || 'Charge number is required',
      });
    }

    const result = await deps.apiClient.post<CardChargeResult>(
      '/charge/card/resume',
      { type: 'api-key', key: apiKey },
      { charge_no: chargeNo },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const charge = result.data;
    notify(format, 'success', 'Card charge resumed');

    const commandResult: CommandResult<CardChargeResult> = {
      data: charge,
      text: () =>
        Formatter.keyValue([
          ['Charge No', charge.charge_no],
          ['Status', charge.status],
          ['Brand', charge.payment_brand],
          ['Amount', `${formatCents(charge.amount_cents)} ${charge.currency}`],
          ['Merchant Trans ID', charge.merchant_trans_id ?? '-'],
          ['EVO Trans ID', charge.evo_trans_id ?? '-'],
        ]),
    };

    const configManager = new ConfigManager();
    await renderWithContext(commandResult, { format }, configManager);
  });
}

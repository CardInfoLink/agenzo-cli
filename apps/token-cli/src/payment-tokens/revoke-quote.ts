import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  PromptEngine,
  resolveFormat,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { attachSchemaHelp, ptRevokeQuoteSchema } from '../verb-schema.js';

interface VcnRevokeQuote {
  balance_cents: number;
  cancel_fee_cents: number;
  can_revoke: boolean;
  refund_cents: number;
  currency: string;
}

function centsToUsd(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Text output for `payment-tokens revoke-quote`. */
export function formatRevokeQuote(quote: VcnRevokeQuote): string {
  return Formatter.keyValue([
    ['Card Balance', centsToUsd(quote.balance_cents)],
    ['Cancel Fee', centsToUsd(quote.cancel_fee_cents)],
    ['Can Cancel', quote.can_revoke ? 'yes' : 'no (balance does not cover the cancel fee; card stays active)'],
    ['Expected Refund', centsToUsd(quote.refund_cents)],
    ['Currency', quote.currency],
  ]);
}

/**
 * `payment-tokens revoke-quote [payment_token_id]` — what cancelling a VCN would do, read-only.
 *
 * Reads: GET /payment-tokens/{id}/revoke-quote?member_id= (X-Api-Key). The platform reads the
 * live card balance; a card whose balance does not cover the cancel fee cannot be cancelled.
 */
export function registerRevokeQuoteCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('revoke-quote [payment_token_id]')
    .description('Quote cancelling a VCN: card balance, cancel fee, expected refund')
    .option('--api-key <key>', 'API key for authentication')
    .option('--id <id>', 'Payment token id (alternative to the positional argument, for flag-only callers)')
    .option('--member <member_id>', 'Only quote if the token belongs to this member');

  attachSchemaHelp(cmd, ptRevokeQuoteSchema);

  cmd.action(async (paymentTokenIdArg: string | undefined) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const paymentTokenId = String(paymentTokenIdArg ?? opts.id ?? '').trim();
    if (!paymentTokenId) {
      throw new CliError('PARAM_INVALID', 'Payment token id is required (positional argument or --id).');
    }
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });
    const member = String(opts.member ?? '').trim();
    const query = member ? `?${new URLSearchParams({ member_id: member }).toString()}` : '';

    const result = await deps.apiClient.get<VcnRevokeQuote>(
      `/payment-tokens/${encodeURIComponent(paymentTokenId)}/revoke-quote${query}`,
      { type: 'api-key', key: apiKey },
    );
    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const commandResult: CommandResult<VcnRevokeQuote> = {
      data: result.data,
      text: () => formatRevokeQuote(result.data),
    };
    await renderWithContext(commandResult, { format }, new ConfigManager());
  });
}

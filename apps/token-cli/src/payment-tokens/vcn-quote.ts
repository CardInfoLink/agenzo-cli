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
import { attachSchemaHelp, ptVcnQuoteSchema } from '../verb-schema.js';
import { usdToCents } from './create.js';

interface VcnQuote {
  amount_cents: number;
  fee_cents: number;
  total_cents: number;
  currency: string;
  card_bin?: string;
}

function centsToUsd(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Text output for `payment-tokens vcn-quote`. */
export function formatVcnQuote(quote: VcnQuote): string {
  return Formatter.keyValue([
    ['Card Limit', centsToUsd(quote.amount_cents)],
    ['Fee', centsToUsd(quote.fee_cents)],
    ['Charge Total', centsToUsd(quote.total_cents)],
    ['Currency', quote.currency],
    ['Card BIN', quote.card_bin ?? '-'],
  ]);
}

/** `--amount-cents` wins when given (programmatic callers already hold cents); else parse / prompt USD. */
async function resolveCents(amount: string | undefined, amountCents: string | undefined): Promise<number> {
  if (amountCents !== undefined) {
    const trimmed = String(amountCents).trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new CliError('PARAM_INVALID', `Invalid --amount-cents "${amountCents}". Expected a positive integer.`);
    }
    return Number(trimmed);
  }
  const amountStr = await PromptEngine.resolveInput(amount, { message: 'Card amount (USD, e.g. 25.00):' });
  try {
    return usdToCents(amountStr);
  } catch {
    throw new CliError('PARAM_INVALID', `Invalid --amount "${amountStr}". Use a decimal like "25.00".`);
  }
}

/**
 * `payment-tokens vcn-quote --amount <usd>` — how much to charge to fund a VCN.
 *
 * Reads: GET /payment-tokens/vcn-quote?amount_cents=&currency=&card_bin= (X-Api-Key).
 * `card_bin` is checked against the issuer's available BINs here, before any money moves.
 * Charge `total_cents` with any brand first, then `payment-tokens create --type vcn
 * --funding-charge-no <charge_no>`.
 */
export function registerVcnQuoteCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('vcn-quote')
    .description('Quote the charge needed to fund a VCN (card amount + fee)')
    .option('--api-key <key>', 'API key for authentication')
    .option('--amount <amount>', 'Card amount in USD, e.g. 25.00')
    .option(
      '--amount-cents <cents>',
      'Card amount in integer cents (alternative to --amount, for programmatic callers)',
    )
    .option('--currency <currency>', 'Currency (default: USD)')
    .option('--card-bin <bin>', '6-8 digit card BIN to issue on (default: platform picks an available BIN)');

  attachSchemaHelp(cmd, ptVcnQuoteSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });
    const cents = await resolveCents(opts.amount as string | undefined, opts.amountCents as string | undefined);
    if (cents < 1) {
      throw new CliError('PARAM_INVALID', 'Amount must be at least $0.01');
    }
    const query = new URLSearchParams({ amount_cents: String(cents) });
    if (opts.currency) {
      query.set('currency', String(opts.currency));
    }
    const cardBin = String(opts.cardBin ?? '').trim();
    if (cardBin) {
      if (!/^\d{6,8}$/.test(cardBin)) {
        throw new CliError('PARAM_INVALID', '--card-bin must be 6-8 digits');
      }
      query.set('card_bin', cardBin);
    }

    const result = await deps.apiClient.get<VcnQuote>(`/payment-tokens/vcn-quote?${query.toString()}`, {
      type: 'api-key',
      key: apiKey,
    });
    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const commandResult: CommandResult<VcnQuote> = {
      data: result.data,
      text: () => formatVcnQuote(result.data),
    };
    await renderWithContext(commandResult, { format }, new ConfigManager());
  });
}

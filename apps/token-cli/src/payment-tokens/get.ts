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
import { attachSchemaHelp, ptGetSchema } from '../verb-schema.js';

// ============================================================
// Formatter — SEPARATE from create's `formatPaymentToken` (Property 7)
// ============================================================

interface FormatPaymentTokenGetOptions {
  revealSensitive?: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function maskPan(value: string, lastFour?: string): string {
  const suffix = lastFour || value.slice(-4);
  if (!suffix) return '';
  const maskedLength = Math.max(value.length - suffix.length, 4);
  return `${'*'.repeat(maskedLength)}${suffix}`;
}

function maskCvc(value: string): string {
  return value ? '***' : '';
}

function maskVcnFields(vcn: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...vcn };
  const lastFour = asString(masked.last_four ?? masked.last4);

  if (typeof masked.card_number === 'string') {
    masked.card_number = maskPan(masked.card_number, lastFour);
  }
  if (typeof masked.pan === 'string') {
    masked.pan = maskPan(masked.pan, lastFour);
  }
  if (typeof masked.cvc === 'string') {
    masked.cvc = maskCvc(masked.cvc);
  }
  if (typeof masked.cvv === 'string') {
    masked.cvv = maskCvc(masked.cvv);
  }

  return masked;
}

/** Build the JSON payload for `payment-tokens get`, masking VCN secrets by default. */
export function buildPaymentTokenGetPayload(
  data: Record<string, unknown>,
  opts: FormatPaymentTokenGetOptions = {},
): Record<string, unknown> {
  if (opts.revealSensitive || data.type !== 'vcn') {
    return data;
  }

  const payload = { ...data };
  if (payload.vcn && typeof payload.vcn === 'object') {
    payload.vcn = maskVcnFields(payload.vcn as Record<string, unknown>);
    return payload;
  }

  return maskVcnFields(payload);
}

/**
 * Format a payment token for the `get` command output (§3.4.3).
 *
 * CRITICAL: This MUST remain a standalone formatter — do NOT converge
 * with `formatPaymentToken` in create.ts. The differences are intentional
 * per design Property 7:
 *
 * - Top key: `Token ID` (create uses `Payment Token ID`)
 * - VCN: includes a `Last 4` line (create does not)
 * - VCN `Limit` / `Balance`: numeric values WITHOUT `$` prefix
 *   (create uses `$` prefix for `Limit`)
 *
 * By default VCN PAN/CVC are masked. Use `--reveal` to intentionally print
 * full VCN credentials for a payment flow that needs to use them.
 */
export function formatPaymentTokenGet(
  data: Record<string, unknown>,
  opts: FormatPaymentTokenGetOptions = {},
): string {
  const type = data.type as string;
  const lines: [string, string][] = [];

  if (type === 'vcn') {
    const vcn = (data.vcn as Record<string, unknown> | undefined) ?? data;
    const lastFour = asString(vcn.last_four ?? vcn.last4);
    const cardNumber = asString(vcn.card_number ?? vcn.pan);
    const cvc = asString(vcn.cvc ?? vcn.cvv);
    lines.push(['Token ID', String(data.id || vcn.id || '')]);
    lines.push(['Type', 'VCN']);
    lines.push([
      'Card Number',
      opts.revealSensitive ? cardNumber : maskPan(cardNumber, lastFour),
    ]);
    lines.push(['Last 4', lastFour]);
    lines.push(['Expiry', String(vcn.expiry || '')]);
    lines.push(['CVC', opts.revealSensitive ? cvc : maskCvc(cvc)]);
    // Limit and Balance: numeric cents → USD string, NO `$` prefix
    lines.push(['Limit', formatCentsPlain(vcn.amount_limit as number)]);
    lines.push(['Balance', formatCentsPlain(vcn.balance as number)]);
    lines.push(['Currency', String(vcn.currency || 'USD')]);
    lines.push(['Status', String(vcn.status || data.status || '')]);
  } else if (type === 'network_token') {
    const nt = (data.network_token as Record<string, unknown> | undefined) ?? data;
    lines.push(['Token ID', String(data.id || nt.id || '')]);
    lines.push(['Type', 'Network Token']);
    lines.push(['Brand', String(nt.payment_brand || nt.brand || '')]);
    lines.push(['ECI', String(nt.eci || '')]);
    lines.push(['Cryptogram', String(nt.token_cryptogram || nt.cryptogram || '')]);
    lines.push(['Expiry', String(nt.expiry_date || nt.expiry || '')]);
    lines.push(['Value', String(nt.value || '')]);
  } else if (type === 'x402') {
    const x402 = (data.x402 as Record<string, unknown> | undefined) ?? data;
    lines.push(['Token ID', String(data.id || x402.id || '')]);
    lines.push(['Type', 'X402']);
    lines.push(['Signature Value', String(x402.signature_value || '')]);
    lines.push(['Status', String(x402.status || data.status || '')]);
  } else {
    // Unknown type: best-effort
    lines.push(['Token ID', String(data.id || '')]);
    lines.push(['Type', String(type || 'unknown')]);
    lines.push(['Status', String(data.status || '')]);
  }

  return Formatter.keyValue(lines);
}

/**
 * Format cents as plain USD string without `$` prefix (e.g. 1250 → "12.50").
 * This is the key difference from create's `formatCentsToUsd` which is used
 * with a `$` prefix in `Limit`.
 */
function formatCentsPlain(cents: number | undefined | null): string {
  if (cents === undefined || cents === null) return '0.00';
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

// ============================================================
// Command registration
// ============================================================

/**
 * `payment-tokens get <payment_token_id>` — show a payment token (§3.4.3).
 *
 * Reads: GET /payment-tokens/<id> (X-Api-Key).
 * Output: keyValue with formatting that DIFFERS from create output (Property 7).
 */
export function registerGetCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('get <payment_token_id>')
    .description('Get a payment token by ID')
    .option('--api-key <key>', 'API key for authentication')
    .option('--reveal', 'Reveal full VCN card number and CVC in the output');

  attachSchemaHelp(cmd, ptGetSchema);

  cmd.action(async (paymentTokenId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    // Resolve API key — prompt interactively if not provided via flag
    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // GET /payment-tokens/<id>
    const result = await deps.apiClient.get<Record<string, unknown>>(
      `/payment-tokens/${paymentTokenId}`,
      { type: 'api-key', key: apiKey },
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const revealSensitive = Boolean(opts.reveal);
    const tokenData = buildPaymentTokenGetPayload(result.data, { revealSensitive });

    const configManager = new ConfigManager();
    const commandResult: CommandResult<Record<string, unknown>> = {
      data: tokenData,
      text: () => formatPaymentTokenGet(result.data, { revealSensitive }),
    };

    await renderWithContext(commandResult, { format }, configManager);
  });
}

import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  Formatter,
  resolveFormat,
  notify,
  CliError,
  IdempotencyKeyRequiredError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import type { RevokeResult } from '../types/api.js';
import { attachSchemaHelp, ptRevokeSchema } from '../verb-schema.js';

/**
 * `payment-tokens revoke <payment_token_id>` — revoke a payment token (§3.4.4).
 *
 * POST /payment-tokens/<id>/revoke (no body).
 * Two output states:
 *   1. Immediate revoke: `✓ Payment token revoked` + Token ID / Status / Revoked At
 *   2. Delayed revoke (X402, status==='ACTIVE' && expires_at non-null):
 *      `✓ Revoke scheduled (cryptogram will auto-expire)` + Token ID / Status / Expires At (+message)
 *
 * Idempotency: --idempotency-key required in --yes mode (Requirement 6.3).
 */
export function registerRevokeCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('revoke <payment_token_id>')
    .description('Revoke a payment token')
    .option('--api-key <key>', 'API key for authentication')
    .option(
      '--idempotency-key <key>',
      'Idempotency key forwarded verbatim as the Idempotency-Key header',
    );

  attachSchemaHelp(cmd, ptRevokeSchema);

  cmd.action(async (paymentTokenId: string) => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    // Idempotency key handling (Requirement 6.3):
    // In --yes mode, --idempotency-key is mandatory — never auto-generate, never send request.
    // In interactive mode, prompt if not provided.
    let idempotencyKey = opts.idempotencyKey as string | undefined;
    if (!idempotencyKey) {
      if (opts.yes) {
        throw new IdempotencyKeyRequiredError('payment-tokens revoke');
      }
      idempotencyKey = await PromptEngine.resolveInput(undefined, {
        message: 'Idempotency key (unique per write, for safe retry):',
        validate: (v) => v.trim().length > 0 || 'Idempotency key is required',
      });
    }

    const extraHeaders: Record<string, string> = {
      'Idempotency-Key': idempotencyKey,
    };

    const result = await deps.apiClient.post<RevokeResult>(
      `/payment-tokens/${paymentTokenId}/revoke`,
      { type: 'api-key', key: apiKey },
      undefined,
      extraHeaders,
    );

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;

    // Determine output state:
    // Delayed revoke (X402): status is still ACTIVE and expires_at is present
    // Immediate revoke: all other cases
    const isDelayedRevoke = data.status === 'ACTIVE' && data.expires_at != null;

    if (isDelayedRevoke) {
      // Delayed revoke (X402 cryptogram will auto-expire)
      notify(format, 'success', 'Revoke scheduled (cryptogram will auto-expire)');

      const kvPairs: [string, string][] = [
        ['Token ID', data.id],
        ['Status', data.status],
        ['Expires At', Formatter.formatTime(data.expires_at)],
      ];
      if (data.message) {
        kvPairs.push(['Message', data.message]);
      }

      const cmdResult: CommandResult<RevokeResult> = {
        data,
        text: () => Formatter.keyValue(kvPairs),
      };

      const configManager = new ConfigManager();
      await renderWithContext(cmdResult, { format }, configManager);
    } else {
      // Immediate revoke
      notify(format, 'success', 'Payment token revoked');

      const cmdResult: CommandResult<RevokeResult> = {
        data,
        text: () =>
          Formatter.keyValue([
            ['Token ID', data.id],
            ['Status', data.status],
            ['Revoked At', Formatter.formatTime(data.revoked_at)],
          ]),
      };

      const configManager = new ConfigManager();
      await renderWithContext(cmdResult, { format }, configManager);
    }
  });
}

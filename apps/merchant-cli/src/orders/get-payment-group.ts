import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  PromptEngine,
  resolveFormat,
  createSpinner,
  CliError,
  renderWithContext,
} from '@agenzo/cli-core';
import type { CommandResult } from '@agenzo/cli-core';
import { attachSchemaHelp, ordersGetPaymentGroupSchema } from '../verb-schema.js';
import { formatPayBatch, type PayBatchResponse } from './pay-batch.js';

/** Platform caps the path segment at 64 chars; anything longer is rejected client-side. */
const PAYMENT_GROUP_ID_MAX = 64;

/**
 * `orders get-payment-group` — read-only status of one aggregate settlement.
 *
 * `GET /orders/payment-groups/<payment_group_id>` with X-Api-Key. Returns the same
 * shape as `orders pay-batch` (settled / partially_settled / failed / uncertain, plus
 * per_order[]), so it is the way to check a batch after `pay-batch` without
 * re-sending the payment write. The platform scopes it to the caller's
 * organization; a group of another organization reads as not found.
 */
export function registerOrdersGetPaymentGroupCommand(parent: Command, deps: { apiClient: ApiClient }): void {
  const cmd = parent
    .command('get-payment-group')
    .description('Get the status of an aggregate settlement created by `orders pay-batch` (read-only)')
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)')
    .requiredOption('--payment-group-id <id>', 'payment_group_id returned by `orders pay-batch`');

  attachSchemaHelp(cmd, ordersGetPaymentGroupSchema);

  cmd.action(async () => {
    const opts = cmd.optsWithGlobals();
    const format = resolveFormat(opts.format as string | undefined);

    const groupId = String(opts.paymentGroupId ?? '').trim();
    if (!groupId || groupId.length > PAYMENT_GROUP_ID_MAX) {
      throw new CliError(
        'PARAM_INVALID',
        `--payment-group-id must be 1-${PAYMENT_GROUP_ID_MAX} characters.`,
      );
    }

    const apiKey = await PromptEngine.resolveInput(opts.apiKey as string | undefined, {
      message: 'API Key:',
      type: 'password',
    });

    const spinner = format === 'json' ? null : createSpinner('Fetching payment group...');
    const result = await deps.apiClient.get<PayBatchResponse>(
      `/orders/payment-groups/${encodeURIComponent(groupId)}`,
      { type: 'api-key', key: apiKey },
    );
    spinner?.stop();

    if (!result.success) {
      throw CliError.fromApi(result, { auth: 'api-key' });
    }

    const data = result.data;
    const commandResult: CommandResult<PayBatchResponse> = {
      data,
      text: () => formatPayBatch(data),
    };
    await renderWithContext(commandResult, { format }, new ConfigManager());
  });
}

import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  Formatter,
  CliError,
  UserCancelError,
  toErrorEnvelope,
  resolveFormat,
  type OutputFormat,
  exitCodeFor,
  getCurrentVersion,
} from '@agenzo/cli-core';

import { registerPayCommand } from './charge/pay.js';

// Holds the parsed program so the top-level error handler can read the
// resolved `--format` global flag.
let programRef: Command | undefined;

async function main() {
  // payment-cli authenticates per-command via `--api-key` (X-Api-Key); the
  // product-line prefix (/api/payment/v1) is injected per-binary.
  const configManager = new ConfigManager(undefined, '/api/payment/v1');
  await configManager.ensureDirectories();

  const apiBaseUrl = await configManager.getApiBaseUrl();
  const apiClient = new ApiClient({ baseUrl: apiBaseUrl });

  const deps = { apiClient };

  const program = new Command();
  programRef = program;
  program
    .name('agenzo-payment-cli')
    .version(getCurrentVersion())
    .description(
      'Agenzo payment plane: charge a previously created payment token (evo / unionpay).',
    )
    .option('--verbose', 'Show verbose logs')
    .option('--yes', 'Skip confirmation prompts (for automation/AI Agents)')
    .option(
      '--format <format>',
      'Output format: json | table (default: table; or set AGENZO_FORMAT)',
    );

  // Mirror the resolved global --format into AGENZO_FORMAT before any action runs.
  program.hook('preAction', (thisCommand) => {
    const flag = thisCommand.opts().format as string | undefined;
    process.env.AGENZO_FORMAT = resolveFormat(flag);
  });

  // charge command group
  const chargeCmd = program.command('charge').description('Charge management');
  registerPayCommand(chargeCmd, deps);

  await program.parseAsync(process.argv);
}

function resolveActiveFormat(): OutputFormat {
  const flag = programRef?.opts().format as string | undefined;
  return resolveFormat(flag);
}

function reportError(error: unknown): never {
  const envelope = toErrorEnvelope(error);
  const format = resolveActiveFormat();

  if (format === 'json') {
    console.error(JSON.stringify(envelope));
  } else {
    console.error(
      Formatter.status('error', `[${envelope.error.code_num}] ${envelope.error.message}`),
    );
    if (!(error instanceof CliError) && process.argv.includes('--verbose')) {
      console.error(error);
    }
  }

  process.exit(exitCodeFor(error));
}

process.on('SIGINT', () => {
  reportError(new UserCancelError());
});

main().catch(reportError);

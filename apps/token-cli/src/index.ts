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

// payment-methods commands
import { registerAddCommand } from './payment-methods/add.js';
import { registerListCommand as registerPmListCommand } from './payment-methods/list.js';
import { registerGetCommand as registerPmGetCommand } from './payment-methods/get.js';
import { registerDisableCommand as registerPmDisableCommand } from './payment-methods/disable.js';

// payment-tokens commands
import { registerCreateCommand } from './payment-tokens/create.js';
import { registerListCommand as registerPtListCommand } from './payment-tokens/list.js';
import { registerGetCommand as registerPtGetCommand } from './payment-tokens/get.js';
import { registerRevokeCommand } from './payment-tokens/revoke.js';

// Holds the parsed program so the top-level error handler can read the
// resolved `--format` global flag. Assigned inside `main()` once the program
// is constructed; may be undefined if an error is thrown before then.
let programRef: Command | undefined;

async function main() {
  // Instantiate shared infrastructure. token-cli authenticates per-command via
  // `--api-key` (X-Api-Key); there is no Bearer session / AuthService / keystore.
  const configManager = new ConfigManager(undefined, '/api/token/v1');
  await configManager.ensureDirectories();

  const apiBaseUrl = await configManager.getApiBaseUrl();
  const apiClient = new ApiClient({ baseUrl: apiBaseUrl });

  // Shared deps object — API Key is supplied per-command, so commands only
  // need the HTTP client.
  const deps = { apiClient };

  // Create program
  const program = new Command();
  programRef = program;
  program
    .name('agenzo-token-cli')
    .version(getCurrentVersion())
    .description(
      'Agenzo token plane: payment methods (add payment method + 3DS) and payment tokens (VCN / Network Token / X402)',
    )
    .option('--verbose', 'Show verbose logs')
    .option('--yes', 'Skip confirmation prompts (for automation/AI Agents)')
    .option(
      '--format <format>',
      'Output format: json | table (default: table; or set AGENZO_FORMAT)',
    );

  // Mirror the resolved global --format into AGENZO_FORMAT before any action
  // runs, so code paths without direct format access can resolve the active
  // format and stay silent in json mode.
  program.hook('preAction', (thisCommand) => {
    const flag = thisCommand.opts().format as string | undefined;
    process.env.AGENZO_FORMAT = resolveFormat(flag);
  });

  // payment-methods command group
  const pmCmd = program.command('payment-methods').description('Payment method management');
  registerAddCommand(pmCmd, deps);
  registerPmListCommand(pmCmd, deps);
  registerPmGetCommand(pmCmd, deps);
  registerPmDisableCommand(pmCmd, deps);

  // payment-tokens command group
  const ptCmd = program.command('payment-tokens').description('Payment token management');
  registerCreateCommand(ptCmd, deps);
  registerPtListCommand(ptCmd, deps);
  registerPtGetCommand(ptCmd, deps);
  registerRevokeCommand(ptCmd, deps);

  // Parse and execute
  await program.parseAsync(process.argv);
}

/**
 * Resolve the active output format for error reporting. Prefers the parsed
 * global `--format` flag (available on `programRef` once the program is
 * constructed); if an error was thrown before parsing, falls back to
 * `resolveFormat(undefined)` (which consults `AGENZO_FORMAT`, else `table`).
 */
function resolveActiveFormat(): OutputFormat {
  const flag = programRef?.opts().format as string | undefined;
  return resolveFormat(flag);
}

/**
 * Top-level failure path. Writes the error envelope to stderr in the resolved
 * format and exits with the mapped code (1–5). stdout is left untouched so a
 * partial machine payload is never emitted on failure.
 *
 * - `json`: a single `{ error: { code, code_num, message, request_id?, upstream? } }` envelope (§8.2).
 * - `table`: `✗ [<code_num>] <message>`, plus a `  ↳ [<upstream.code>] <upstream.message>`
 *   line when this failure originated from a third-party upstream (e.g. EVO card/network-
 *   token binding) the platform calls out to.
 */
function reportError(error: unknown): never {
  const envelope = toErrorEnvelope(error);
  const format = resolveActiveFormat();

  if (format === 'json') {
    console.error(JSON.stringify(envelope));
  } else {
    console.error(
      Formatter.status('error', `[${envelope.error.code_num}] ${envelope.error.message}`),
    );
    if (envelope.error.upstream) {
      console.error(`  ↳ [${envelope.error.upstream.code}] ${envelope.error.upstream.message}`);
    }
    // Unknown (non-CliError) failures keep the --verbose raw-dump affordance.
    if (!(error instanceof CliError) && process.argv.includes('--verbose')) {
      console.error(error);
    }
  }

  // exitCodeFor owns the error-class → exit-code matrix, including
  // UpgradeRequiredError → 2 and UserCancelError → 5.
  process.exit(exitCodeFor(error));
}

// Ctrl+C / SIGINT maps to a user-cancel (exit 5) via the same envelope path.
process.on('SIGINT', () => {
  reportError(new UserCancelError());
});

// Global error handler. Normal completion exits 0 naturally (the mapper is
// never consulted on success).
main().catch(reportError);

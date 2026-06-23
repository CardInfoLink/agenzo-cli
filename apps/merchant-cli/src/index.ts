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

// ride-elife commands (injection-style register, D6)
import { registerQuoteCommand } from './ride-elife/quote.js';
import { registerBookCommand } from './ride-elife/book.js';
import { registerRideGetCommand } from './ride-elife/get.js';
import { registerCancelCommand } from './ride-elife/cancel.js';
import { registerListOrdersCommand } from './ride-elife/list-orders.js';

// services commands (CLI-bundled registry, D4)
import { registerServicesListCommand } from './services/list.js';
import { registerServiceGetCommand } from './services/get.js';

// Holds the parsed program so the top-level error handler can read the
// resolved `--format` global flag. Assigned inside `main()` once the program
// is constructed; may be undefined if an error is thrown before then.
let programRef: Command | undefined;

async function main() {
  // Instantiate shared infrastructure. merchant-cli authenticates per-command
  // via `--api-key` (X-Api-Key); there is no Bearer session / AuthService /
  // keystore. The no-arg ConfigManager reuses cli-core's default config (the
  // environment admin-cli governs) purely to supply the ApiClient baseUrl and
  // the json envelope's profile/endpoint — merchant-cli exposes no host
  // commands of its own.
  const configManager = new ConfigManager(undefined, '/api/merchant/v1');
  await configManager.ensureDirectories();

  const apiBaseUrl = await configManager.getApiBaseUrl();
  const apiClient = new ApiClient({ baseUrl: apiBaseUrl });

  // Shared deps object for networked commands — API Key is supplied per-command
  // (or interactively), so commands only need the HTTP client.
  const deps = { apiClient };

  // Create program
  const program = new Command();
  programRef = program;
  program
    .name('agenzo-merchant-cli')
    .version(getCurrentVersion())
    .description(
      'Agenzo merchant fulfillment plane: service discovery (services) and ride ordering (ride-elife)',
    )
    .option('--verbose', 'Show verbose logs')
    .option('--yes', 'Skip confirmation prompts (for automation/AI Agents)')
    // merchant-cli is an agent-first entrypoint, so it defaults to json (D2),
    // unlike the cli-core default (table). resolveFormat only acts as a
    // fallback when the flag is absent.
    .option(
      '--format <format>',
      'Output format: json | table (default: json; or set AGENZO_FORMAT)',
      'json',
    )
    .option('--api-key <key>', 'API Key for authentication (X-Api-Key)');

  // Mirror the resolved global --format into AGENZO_FORMAT before any action
  // runs, so code paths without direct format access can resolve the active
  // format and stay silent in json mode.
  program.hook('preAction', (thisCommand) => {
    const flag = thisCommand.opts().format as string | undefined;
    process.env.AGENZO_FORMAT = resolveFormat(flag);
  });

  // ride-elife command group (eLife ride ordering)
  const rideCmd = program.command('ride-elife').description('Ride ordering (eLife)');
  registerQuoteCommand(rideCmd, deps);
  registerBookCommand(rideCmd, deps);
  registerRideGetCommand(rideCmd, deps);
  registerCancelCommand(rideCmd, deps);
  registerListOrdersCommand(rideCmd, deps);

  // services command group (CLI-bundled capability discovery)
  const servicesCmd = program.command('services').description('Merchant service discovery');
  registerServicesListCommand(servicesCmd);
  registerServiceGetCommand(servicesCmd);

  // Parse and execute
  await program.parseAsync(process.argv);
}

/**
 * Resolve the active output format for error reporting. Prefers the parsed
 * global `--format` flag (available on `programRef` once the program is
 * constructed; defaults to `json` for merchant-cli); if an error was thrown
 * before parsing, falls back to `resolveFormat(undefined)` (which consults
 * `AGENZO_FORMAT`, else `table`).
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
 * - `json`: a single `{ error: { code, code_num, message, request_id? } }` envelope (§8.2).
 * - `table`: `✗ [<code_num>] <message>`.
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

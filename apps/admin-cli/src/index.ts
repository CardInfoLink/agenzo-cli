import { Command } from 'commander';
import {
  ApiClient,
  ConfigManager,
  CredentialStore,
  KeyStore,
  Formatter,
  CliError,
  AuthError,
  UserCancelError,
  toErrorEnvelope,
  resolveFormat,
  type OutputFormat,
  exitCodeFor,
  getCurrentVersion,
} from '@agenzo/cli-core';
import { AuthService } from './auth/auth-service.js';

// Auth commands
import { registerLoginCommand } from './auth/login.js';
import { registerLogoutCommand } from './auth/logout.js';

// Config commands
import { registerConfigCommand } from './config/set.js';

// Orgs commands
import { registerMeCommand } from './orgs/get.js';
import { registerUpdateCommand as registerOrgUpdateCommand } from './orgs/update.js';
import { registerListCommand as registerOrgListCommand } from './orgs/list.js';
import { registerSwitchCommand } from './orgs/switch.js';

// Developers commands
import { registerCreateCommand as registerDevCreateCommand } from './developers/create.js';
import { registerListCommand as registerDevListCommand } from './developers/list.js';
import { registerGetCommand as registerDevGetCommand } from './developers/get.js';
import { registerUpdateCommand as registerDevUpdateCommand } from './developers/update.js';

// Keys commands
import { registerCreateCommand as registerKeyCreateCommand } from './keys/create.js';
import { registerListCommand as registerKeyListCommand } from './keys/list.js';
import { registerGetCommand as registerKeyGetCommand } from './keys/get.js';
import { registerRotateCommand } from './keys/rotate.js';
import { registerDisableCommand as registerKeyDisableCommand } from './keys/disable.js';

// Accounts commands
import { registerGetCommand as registerAccountGetCommand } from './accounts/get.js';

// Holds the parsed program so the top-level error handler can read the
// resolved `--format` global flag. Assigned inside `main()` once the program
// is constructed; may be undefined if an error is thrown before then.
let programRef: Command | undefined;

async function main() {
  // Instantiate shared infrastructure
  const configManager = new ConfigManager(undefined, '/api/admin/v1');
  await configManager.ensureDirectories();

  const credentialStore = new CredentialStore();
  const keyStore = new KeyStore();

  const apiBaseUrl = await configManager.getApiBaseUrl();
  const apiClient = new ApiClient({ baseUrl: apiBaseUrl });

  const authService = new AuthService(apiClient, credentialStore, configManager);

  // Shared deps objects
  const controlPlaneDeps = { apiClient, authService, credentialStore, configManager };
  const keysDeps = { apiClient, authService, keyStore, configManager };
  const orgsDeps = { credentialStore, configManager };

  // Create program
  const program = new Command();
  programRef = program;
  program
    .name('agenzo-admin-cli')
    .version(getCurrentVersion())
    .description(
      'Agenzo control plane: login, organizations, developers, API keys, settlement accounts, and config',
    )
    .option('--verbose', 'Show verbose logs')
    .option('--yes', 'Skip confirmation prompts (for automation/AI Agents)')
    .option(
      '--format <format>',
      'Output format: json | table (default: table; or set AGENZO_FORMAT)',
    );

  // Mirror the resolved global --format into AGENZO_FORMAT before any action
  // runs, so code paths without direct format access (e.g. AuthService's
  // auto re-login deep inside executeWithAuth) can resolve the active format
  // and stay silent in json mode. resolveFormat already honors the flag; this
  // just makes the flag value visible to env-based readers.
  program.hook('preAction', (thisCommand) => {
    const flag = thisCommand.opts().format as string | undefined;
    process.env.AGENZO_FORMAT = resolveFormat(flag);
  });

  // Auth command group
  const authCmd = program.command('auth').description('Authentication');
  registerLoginCommand(authCmd, { authService, configManager });
  registerLogoutCommand(authCmd, { authService, configManager });

  // Config command
  registerConfigCommand(program, { configManager, credentialStore });

  // Orgs command group
  const orgsCmd = program.command('orgs').description('Organization management');
  registerMeCommand(orgsCmd, controlPlaneDeps);
  registerOrgUpdateCommand(orgsCmd, controlPlaneDeps);
  registerOrgListCommand(orgsCmd, orgsDeps);
  registerSwitchCommand(orgsCmd, orgsDeps);

  // Developers command group
  const devsCmd = program.command('developers').description('Developer management');
  registerDevCreateCommand(devsCmd, controlPlaneDeps);
  registerDevListCommand(devsCmd, controlPlaneDeps);
  registerDevGetCommand(devsCmd, controlPlaneDeps);
  registerDevUpdateCommand(devsCmd, controlPlaneDeps);

  // Keys command group
  const keysCmd = program.command('keys').description('API Key management');
  registerKeyCreateCommand(keysCmd, keysDeps);
  registerKeyListCommand(keysCmd, controlPlaneDeps);
  registerKeyGetCommand(keysCmd, controlPlaneDeps);
  registerRotateCommand(keysCmd, keysDeps);
  registerKeyDisableCommand(keysCmd, controlPlaneDeps);

  // Accounts command group
  const accountsCmd = program.command('accounts').description('Settlement account management');
  registerAccountGetCommand(accountsCmd, controlPlaneDeps);

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
 * - `table`: `✗ [<code_num>] <message>` plus, for `AuthError`, the suggestion line, plus a
 *   `  ↳ [<upstream.code>] <upstream.message>` line when this failure originated from a
 *   third-party upstream the platform calls out to.
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
    if (error instanceof AuthError) {
      console.error(Formatter.status('info', error.suggestion));
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

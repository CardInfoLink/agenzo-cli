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

// hotel-redaug commands (injection-style register, D6)
import { registerHotelSearchCommand } from './hotel-redaug/search.js';
import { registerHotelQuoteCommand } from './hotel-redaug/quote.js';
import { registerHotelCreateOrderCommand } from './hotel-redaug/create-order.js';
import { registerHotelPayOrderCommand } from './hotel-redaug/pay-order.js';
import { registerHotelGetCommand } from './hotel-redaug/get.js';
import { registerHotelCancelCommand } from './hotel-redaug/cancel.js';
import { registerHotelCheckoutCommand } from './hotel-redaug/checkout.js';
import { registerHotelGetCheckoutCommand } from './hotel-redaug/get-checkout.js';
import { registerHotelListOrdersCommand } from './hotel-redaug/list-orders.js';
import { registerHotelFindDestinationCommand } from './hotel-redaug/find-destination.js';
import { registerHotelFiltersCommand } from './hotel-redaug/hotel-filters.js';
import { registerHotelListCitiesCommand } from './hotel-redaug/list-cities.js';
import { registerHotelDetailCommand } from './hotel-redaug/hotel-detail.js';
import { registerHotelSkillCommand } from './hotel-redaug/skill.js';

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

  // Discovery lives at the host root (/api/discovery/v1/catalog), NOT under the
  // per-binary merchant prefix, so it needs its own client built from the raw
  // host. Built here (not inside the action) so it can be injected/mocked.
  const apiHost = await configManager.getApiHost();
  const discoveryClient = new ApiClient({ baseUrl: apiHost });

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
      'Agenzo merchant fulfillment plane: service discovery (services), ride ordering (ride-elife), and hotel booking (hotel-redaug)',
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

  // services command group (capability discovery via platform backend + local fallback).
  // These commands gate backend capabilities against the CLI's own command tree,
  // so they need the root `program` to introspect registered nouns/verbs, plus
  // the host-root discovery client.
  const servicesCmd = program.command('services').description('Merchant service discovery');
  registerServicesListCommand(servicesCmd, { discoveryClient, program });
  registerServiceGetCommand(servicesCmd, { discoveryClient, program });

  // hotel-redaug command group (Redaug hotel booking) — 13 verbs
  const hotelCmd = program.command('hotel-redaug').description(
    `Hotel booking (Redaug) — international hotel search, quote, create-order, pay-order, cancel, and check-out.

Workflow (typical order):
  1. find-destination  Resolve a place name → coordinates (or destination_id via list-cities)
  2. hotel-filters     (optional) Get filter options for a location (star/brand/facility codes)
  3. search            Search hotels by coordinates OR destination_id, with date/guest/filter params
  4. hotel-detail      (optional) View hotel info: address, facilities, images
  5. quote             Get real-time room rates for a hotel + dates → product_token + price_items
  6. create-order      Create order using product_token from quote (lock inventory, no charge)
  7. pay-order         Settle the order (monthly_settlement or Active_Payment via --merchant-trans-id)
  8. get               Poll order status until CONFIRMED (or use --watch for NDJSON stream)
  9. cancel            Cancel an order (whole-order, within policy)
 10. checkout          Apply for partial check-out / out-of-policy cancellation (async)
 11. get-checkout      Poll checkout application status
 12. list-orders       List developer's hotel orders

Key notes:
  • search has two location branches: --destination-id OR --lat/--lng (exactly one required)
  • create-order locks inventory without charging; order enters AWAITING_PAYMENT
  • pay-order settles the order: omit --merchant-trans-id for monthly_settlement,
    supply it for Active_Payment (EVO); use --watch to poll until PAID
  • All amounts are DECIMAL (e.g. 10.00 = ten yuan), never minor units (cents)
  • product_token from quote is opaque — pass it unchanged to create-order
  • price_items from quote must be copied verbatim as --price-items JSON array to create-order`,
  );
  registerHotelSearchCommand(hotelCmd, deps);
  registerHotelQuoteCommand(hotelCmd, deps);
  registerHotelCreateOrderCommand(hotelCmd, deps);
  registerHotelPayOrderCommand(hotelCmd, deps);
  registerHotelGetCommand(hotelCmd, deps);
  registerHotelCancelCommand(hotelCmd, deps);
  registerHotelCheckoutCommand(hotelCmd, deps);
  registerHotelGetCheckoutCommand(hotelCmd, deps);
  registerHotelListOrdersCommand(hotelCmd, deps);
  registerHotelFindDestinationCommand(hotelCmd, deps);
  registerHotelFiltersCommand(hotelCmd, deps);
  registerHotelListCitiesCommand(hotelCmd, deps);
  registerHotelDetailCommand(hotelCmd, deps);
  registerHotelSkillCommand(hotelCmd);

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

/**
 * `--help --format json` verb-level schema (§4.4.1.3 pattern) — token domain.
 *
 * Mirrors `apps/merchant-cli/src/verb-schema.ts`: every payment-methods /
 * payment-tokens verb supports `--help --format json`, which prints a single
 * machine-readable JSON object describing the verb instead of commander's
 * default text help. This is how an Agent discovers a verb's flags, response
 * shape, and example invocation locally, without a network round-trip.
 *
 * Before this file existed, token-cli's `--help` always rendered commander's
 * default TEXT help regardless of `--format json` — the orchestrator's tool
 * discovery (`agenzo-agent-orchestrator/app/providers/cli_provider.py`) could
 * not parse it as JSON, so every payment-methods / payment-tokens verb was
 * silently dropped from the LLM's tool list (`cli_provider.verb_schema_skip`).
 * A user typing "bind card" / "add a card" in chat would hit an LLM with NO
 * card-binding tool available — even though the underlying CLI command works
 * fine when invoked directly, and the deterministic "Add card" button UI
 * (dropin-session flow) bypasses tool discovery entirely and was never
 * affected. This file closes that gap for the LLM tool-discovery path only.
 *
 * Mechanism (commander v14): `attachSchemaHelp` overrides a command's
 * `helpInformation`. Commander resolves `--help` BEFORE later argv tokens are
 * applied to options, so the parsed `--format` value is not yet available when
 * help renders — we therefore read it straight from `process.argv`. Only an
 * explicit `--format json` switches to the JSON schema; bare `--help` and
 * `--help --format table` keep commander's default text help.
 */
import type { Command } from 'commander';

const CLI_NAME = 'agenzo-token-cli';
export const PAYMENT_METHODS_NOUN = 'payment-methods';
export const PAYMENT_TOKENS_NOUN = 'payment-tokens';

// ============================================================
// Schema shape (kept identical to merchant-cli's VerbSchema)
// ============================================================

/** One flag descriptor: type / required / optional default / description / constraints. */
export interface FlagSchema {
  type: string;
  /** `true` / `false`, or the literal `'conditional'` for mode-dependent flags. */
  required: boolean | 'conditional';
  default?: unknown;
  description: string;
  constraints?: string;
}

/** A complete, copy-pasteable example invocation plus what to read from the output. */
export interface ExampleSchema {
  command: string;
  output_summary: string;
}

/**
 * The verb-level schema object emitted by `--help --format json`:
 * `{ cli, noun, verb, description, flags, response, example, [error_recovery] }`.
 */
export interface VerbSchema {
  cli: string;
  noun: string;
  verb: string;
  description: string;
  flags: Record<string, FlagSchema>;
  response: Record<string, unknown>;
  example: ExampleSchema;
  error_recovery?: Record<string, string>;
}

// ============================================================
// Emit + attach mechanism (identical to merchant-cli)
// ============================================================

export function wantsJsonSchema(argv: string[] = process.argv): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format=json') return true;
    if (a === '--format' && argv[i + 1] === 'json') return true;
  }
  return false;
}

/** Print a verb schema as a single pretty-printed JSON object to stdout. */
export function emitSchema(schema: VerbSchema): void {
  console.log(JSON.stringify(schema, null, 2));
}

/**
 * Attach `--help --format json` schema output to a command. When help is
 * requested with an explicit `--format json`, the schema is printed to stdout
 * and an empty string is returned so commander prints nothing further and exits
 * cleanly. Otherwise the original (text) help is rendered unchanged.
 */
export function attachSchemaHelp(cmd: Command, schema: VerbSchema): Command {
  const baseHelp = cmd.helpInformation.bind(cmd);
  cmd.helpInformation = (context) => {
    if (!wantsJsonSchema()) return baseHelp(context);
    emitSchema(schema);
    return '';
  };
  return cmd;
}

// ============================================================
// payment-methods verb schemas
// ============================================================

/** `payment-methods add` schema. Write op (W/Y in manual mode; dropin mode is non-blocking). */
export const pmAddSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_METHODS_NOUN,
  verb: 'add',
  description: 'Add a payment method (manual 3DS or Drop-in session)',
  flags: {
    type: { type: 'string', required: false, default: 'card', description: 'Payment method type' },
    mode: {
      type: 'string',
      required: false,
      default: 'manual',
      description:
        'Add mode: "manual" (CLI collects card details and polls 3DS) or "dropin" (mint a Drop-in session; the app opens the Drop-in SDK for the user to enter card details securely — use this mode when the user wants to bind/add a card from chat)',
      constraints: 'manual | dropin',
    },
    email: {
      type: 'string',
      required: 'conditional',
      description:
        "Manual mode: email for 3DS verification. Dropin mode: email used as the Drop-in session reference. Use the user's login profile email — never ask in chat.",
    },
    'idempotency-key': {
      type: 'string',
      required: false,
      description: 'Idempotency key forwarded verbatim as the Idempotency-Key header (manual mode only)',
    },
    'no-poll': {
      type: 'bool',
      required: false,
      default: false,
      description:
        'Dropin mode: mint the session, print it, and exit immediately without polling verification status (for server/SDK-driven flows where the front-end completes the binding). Agents integrating with a UI card flow should set this.',
    },
  },
  response: {
    id: { type: 'string', description: 'Payment method id' },
    session_id: { type: 'string|absent', description: 'Drop-in session id (dropin mode only) — pass to the front-end Drop-in SDK, never read aloud to the user' },
    status: { type: 'string', description: 'PENDING | ACTIVE | FAILED | EXPIRED' },
    brand: { type: 'string|absent', description: 'Card brand, once known' },
    last4: { type: 'string|absent', description: 'Card last 4 digits, once known' },
  },
  example: {
    command: 'agenzo-token-cli payment-methods add --mode dropin --email user@example.com --no-poll',
    output_summary:
      'Dropin mode returns { id, session_id }. Never read card numbers/CVV/expiry to or from the user (PCI) — the Drop-in SDK collects them securely.',
  },
  error_recovery: {
    PARAM_INVALID: 'Fix the offending flag (mode must be "manual" or "dropin"), then retry.',
  },
};

/** `payment-methods list` schema. Read-only. */
export const pmListSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_METHODS_NOUN,
  verb: 'list',
  description: 'List payment methods',
  flags: {
    member: { type: 'string', required: false, description: 'Filter by member ID' },
  },
  response: {
    payment_methods: {
      type: 'array',
      description: 'Payment methods for the developer (optionally scoped to --member)',
      items: {
        id: { type: 'string', description: 'Payment method id' },
        type: { type: 'string', description: 'Payment method type (e.g. card)' },
        status: { type: 'string', description: 'PENDING | ACTIVE | FAILED | DISABLED | EXPIRED' },
        brand: { type: 'string|null', description: 'Card brand' },
        first6: { type: 'string|null', description: 'Card first 6 digits' },
        last4: { type: 'string|null', description: 'Card last 4 digits' },
      },
    },
  },
  example: {
    command: 'agenzo-token-cli payment-methods list',
    output_summary: 'Returns payment_methods[]. Check for status=ACTIVE before assuming the user has a usable card.',
  },
};

/** `payment-methods get <pm_id>` schema. Read-only. */
export const pmGetSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_METHODS_NOUN,
  verb: 'get',
  description: 'Get a payment method by ID',
  flags: {
    pm_id: { type: 'string', required: true, description: 'Payment method id (positional argument)' },
  },
  response: {
    id: { type: 'string', description: 'Payment method id' },
    type: { type: 'string', description: 'Payment method type' },
    status: { type: 'string', description: 'PENDING | ACTIVE | FAILED | DISABLED | EXPIRED' },
    brand: { type: 'string|null', description: 'Card brand' },
    first6: { type: 'string|null', description: 'Card first 6 digits' },
    last4: { type: 'string|null', description: 'Card last 4 digits' },
    created_at: { type: 'string', description: 'Creation time' },
  },
  example: {
    command: 'agenzo-token-cli payment-methods get pm_01H...',
    output_summary: 'Returns the payment method detail including status.',
  },
};

/** `payment-methods disable <pm_id>` schema. Write op (W/Y). */
export const pmDisableSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_METHODS_NOUN,
  verb: 'disable',
  description: 'Disable a payment method',
  flags: {
    pm_id: { type: 'string', required: true, description: 'Payment method id (positional argument)' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Idempotency key forwarded verbatim as the Idempotency-Key header',
    },
  },
  response: {
    status: { type: 'string', description: 'Status after disabling (typically DISABLED)' },
    revoked_tokens_count: { type: 'int', description: 'Number of payment tokens revoked as a side effect' },
  },
  example: {
    command: 'agenzo-token-cli payment-methods disable pm_01H... --idempotency-key disable-123',
    output_summary: 'Disables the card and revokes any payment tokens issued against it. Only use when the user explicitly requests it.',
  },
  error_recovery: {
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Supply --idempotency-key (1-128 chars [A-Za-z0-9_-]); the CLI never generates one under --yes.',
  },
};

// ============================================================
// payment-tokens verb schemas
// ============================================================

/** `payment-tokens create` schema. Write op (W/Y). */
export const ptCreateSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_TOKENS_NOUN,
  verb: 'create',
  description: 'Create a payment token (VCN / Network Token / X402)',
  flags: {
    type: { type: 'string', required: true, description: 'Token type', constraints: 'vcn | network-token | x402' },
    'payment-method-id': { type: 'string', required: 'conditional', description: 'Payment method ID to use (or resolved via --card / auto-select from ACTIVE cards)' },
    card: { type: 'string', required: false, description: 'Match payment method by last 4 digits' },
    member: { type: 'string', required: false, description: 'Member ID' },
    amount: { type: 'string', required: 'conditional', description: 'Amount in USD (vcn) or USDC (x402)' },
    currency: { type: 'string', required: false, description: 'Currency (vcn only; server default applies if omitted)' },
    'pay-to': { type: 'string', required: 'conditional', description: 'Pay-to address (x402 only)' },
    nonce: { type: 'string', required: 'conditional', description: 'Nonce (x402 only)' },
    network: { type: 'string', required: 'conditional', description: 'Network (x402 only)' },
    deadline: { type: 'string', required: 'conditional', description: 'Deadline as a Unix timestamp in seconds (x402 only)' },
    'external-tx-id': { type: 'string', required: false, description: 'External transaction ID' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Idempotency key forwarded verbatim as the Idempotency-Key header',
    },
  },
  response: {
    id: { type: 'string', description: 'Payment token id' },
    type: { type: 'string', description: 'vcn | network_token | x402' },
    status: { type: 'string', description: 'Token status' },
  },
  example: {
    command: 'agenzo-token-cli payment-tokens create --type vcn --card 1234 --amount 25.00 --idempotency-key tok-123',
    output_summary: 'Creates a token; response shape varies by type (nested under vcn / network_token / x402).',
  },
  error_recovery: {
    TOKEN_FEATURE_DISABLED: 'This token type is not enabled yet. Tell the user and suggest an alternative type if applicable.',
    CLIENT_NO_PAYMENT_METHOD: 'The user has no ACTIVE payment method. Guide them to add one first (payment-methods add --mode dropin).',
    CLIENT_CARD_NOT_MATCHED: 'The --card last-4 did not match any ACTIVE card. Call payment-methods list to see available cards.',
  },
};

/** `payment-tokens list` schema. Read-only. */
export const ptListSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_TOKENS_NOUN,
  verb: 'list',
  description: 'List payment tokens',
  flags: {
    type: { type: 'string', required: false, description: 'Filter by token type' },
    member: { type: 'string', required: false, description: 'Filter by member ID' },
  },
  response: {
    payment_tokens: {
      type: 'array',
      description: 'Payment tokens for the developer (optionally filtered)',
      items: {
        id: { type: 'string', description: 'Token id' },
        type: { type: 'string', description: 'vcn | network_token | x402' },
        status: { type: 'string', description: 'Token status' },
      },
    },
  },
  example: {
    command: 'agenzo-token-cli payment-tokens list --type vcn',
    output_summary: 'Returns payment_tokens[].',
  },
};

/** `payment-tokens get <payment_token_id>` schema. Read-only. */
export const ptGetSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_TOKENS_NOUN,
  verb: 'get',
  description: 'Get a payment token by ID',
  flags: {
    payment_token_id: { type: 'string', required: true, description: 'Payment token id (positional argument)' },
    reveal: {
      type: 'bool',
      required: false,
      default: false,
      description: 'Reveal full VCN card number and CVC in the output. NEVER pass this or read revealed card data aloud to the user (PCI) unless explicitly required by a payment flow.',
    },
  },
  response: {
    id: { type: 'string', description: 'Token id' },
    type: { type: 'string', description: 'vcn | network_token | x402' },
    status: { type: 'string', description: 'Token status' },
  },
  example: {
    command: 'agenzo-token-cli payment-tokens get pt_01H...',
    output_summary: 'Returns the token detail. VCN PAN/CVC are masked unless --reveal is set.',
  },
};

/** `payment-tokens revoke <payment_token_id>` schema. Write op (W/Y). */
export const ptRevokeSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: PAYMENT_TOKENS_NOUN,
  verb: 'revoke',
  description: 'Revoke a payment token',
  flags: {
    payment_token_id: { type: 'string', required: true, description: 'Payment token id (positional argument)' },
    'idempotency-key': {
      type: 'string',
      required: true,
      description: 'Idempotency key forwarded verbatim as the Idempotency-Key header',
    },
  },
  response: {
    id: { type: 'string', description: 'Token id' },
    status: { type: 'string', description: 'Status after revocation' },
    revoked_at: { type: 'string|absent', description: 'Revocation time (immediate revoke)' },
    expires_at: { type: 'string|absent', description: 'Expiry time (delayed revoke — x402 cryptogram auto-expires)' },
  },
  example: {
    command: 'agenzo-token-cli payment-tokens revoke pt_01H... --idempotency-key revoke-123',
    output_summary: 'Revokes the token immediately, or schedules a delayed revoke for x402 (status stays ACTIVE until expires_at).',
  },
  error_recovery: {
    PARAM_IDEMPOTENCY_KEY_REQUIRED: 'Supply --idempotency-key (1-128 chars [A-Za-z0-9_-]); the CLI never generates one under --yes.',
  },
};

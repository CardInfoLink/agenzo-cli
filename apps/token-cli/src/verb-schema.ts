/**
 * `--help --format json` verb-level schema (§4.4.1.3) — token domain.
 *
 * Every payment-methods / payment-tokens verb supports `--help --format json`,
 * emitting a machine-readable JSON object describing the verb. This is the
 * standard way an Agent (orchestrator) discovers flags, response shape, and
 * error-recovery guidance locally, without a network round-trip.
 *
 * Mechanism: identical to merchant-cli — `attachSchemaHelp` overrides a
 * command's `helpInformation`. Only an explicit `--format json` in argv
 * switches to JSON schema output; bare `--help` keeps commander text.
 */
import type { Command } from 'commander';

const CLI_NAME = 'agenzo-token-cli';

// ============================================================
// Schema shape (reusable interfaces)
// ============================================================

export interface FlagSchema {
  type: string;
  required: boolean | 'conditional';
  default?: unknown;
  description: string;
  constraints?: string;
  /** Hint for orchestrator: where this value comes from. */
  source?: 'user' | 'from_previous_step' | 'agent_generated' | 'config';
  /** When source=from_previous_step, which field to take from. */
  from?: string;
}

export interface ExampleSchema {
  command: string;
  output_summary: string;
}

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

export function emitSchema(schema: VerbSchema): void {
  console.log(JSON.stringify(schema, null, 2));
}

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

export const pmAddSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: 'payment-methods',
  verb: 'add',
  description:
    'Add a payment method. --payment-brand evo (default): card binding + 3DS via Drop-in session. ' +
    '--payment-brand unionpay: UPI Agent Pay enrollment (requires --member); returns enroll_url, ' +
    'result arrives asynchronously via webhook.',
  flags: {
    'payment-brand': {
      type: 'string',
      required: false,
      default: 'evo',
      description:
        'Payment brand: "evo" (default; 3DS/Drop-in binding) or "unionpay" (UPI Agent Pay enrollment)',
      constraints: 'evo | unionpay',
    },
    member: {
      type: 'string',
      required: 'conditional',
      description:
        'End-user member id (required when --payment-brand unionpay; identifies which user this card belongs to). ' +
        'Ignored for evo payment brand.',
      source: 'from_previous_step',
      from: 'user.member_id or auth context',
    },
    mode: {
      type: 'string',
      required: false,
      default: 'dropin',
      description:
        'Add mode (evo payment brand only): "manual" (CLI collects card details) or "dropin" (mint a Drop-in session)',
      constraints: 'manual | dropin',
    },
    email: {
      type: 'string',
      required: false,
      description: 'Email for 3DS verification (evo/manual) or Drop-in session reference (evo/dropin)',
    },
    'no-poll': {
      type: 'bool',
      required: false,
      default: false,
      description:
        'Dropin mode: mint session and exit immediately without polling verification status',
    },
  },
  response: {
    id: { type: 'string', description: 'Payment method id' },
    status: {
      type: 'string',
      description: 'PENDING (awaiting enrollment/3DS) / ACTIVE / FAILED / DISABLED',
    },
    'payment-brand': { type: 'string', description: 'evo or unionpay' },
    session_id: {
      type: 'string|absent',
      description: 'Drop-in session id (evo/dropin mode only)',
    },
    enroll_url: {
      type: 'string|absent',
      description: 'UnionPay enrollment URL (unionpay payment brand only) — user opens this to bind card',
    },
    correlation_id: {
      type: 'string|absent',
      description: 'src_correlation_id for tracking enrollment result (unionpay payment brand only)',
    },
  },
  example: {
    command:
      'agenzo-token-cli payment-methods add --payment-brand unionpay --member usr_abc123 --format json',
    output_summary:
      'Returns enroll_url. User opens the URL in a browser to complete card binding. ' +
      'Result arrives async via webhook; poll with `payment-methods list` or `payment-methods get`.',
  },
  error_recovery: {
    PARAM_INVALID:
      'Fix the offending flag (--payment-brand must be evo|unionpay; --member required for unionpay).',
    UPSTREAM_ERROR:
      'UPI enrollment initiation failed. Retry after a short delay (may be transient network).',
    MEMBER_REQUIRED:
      'UnionPay payment brand requires --member <id>. Supply the end-user member identifier.',
  },
};

export const pmListSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: 'payment-methods',
  verb: 'list',
  description: 'List all payment methods for the authenticated developer',
  flags: {},
  response: {
    payment_methods: {
      type: 'array',
      description: 'List of payment methods',
      items: {
        id: { type: 'string', description: 'Payment method id' },
        status: { type: 'string', description: 'PENDING / ACTIVE / FAILED / DISABLED' },
        payment_brand: { type: 'string', description: 'evo or unionpay' },
        brand: { type: 'string|null', description: 'Card brand (Visa, Mastercard, UnionPay, etc.)' },
        last4: { type: 'string|null', description: 'Last 4 digits of card' },
        exp_month: { type: 'int|null', description: 'Expiry month' },
        exp_year: { type: 'int|null', description: 'Expiry year' },
      },
    },
  },
  example: {
    command: 'agenzo-token-cli payment-methods list --format json',
    output_summary: 'Returns array of payment methods with status and card info.',
  },
};

export const pmGetSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: 'payment-methods',
  verb: 'get',
  description: 'Get a payment method by ID',
  flags: {
    id: { type: 'string', required: true, description: 'Payment method id', source: 'from_previous_step', from: 'payment_methods[].id' },
  },
  response: {
    id: { type: 'string', description: 'Payment method id' },
    status: { type: 'string', description: 'PENDING / ACTIVE / FAILED / DISABLED' },
    payment_brand: { type: 'string', description: 'evo or unionpay' },
    brand: { type: 'string|null', description: 'Card brand' },
    last4: { type: 'string|null', description: 'Last 4 digits' },
    exp_month: { type: 'int|null', description: 'Expiry month' },
    exp_year: { type: 'int|null', description: 'Expiry year' },
  },
  example: {
    command: 'agenzo-token-cli payment-methods get --id pm_abc123 --format json',
    output_summary: 'Returns full payment method details including card info and status.',
  },
};

export const pmDisableSchema: VerbSchema = {
  cli: CLI_NAME,
  noun: 'payment-methods',
  verb: 'disable',
  description: 'Disable a payment method (cascades revoke on active tokens)',
  flags: {
    id: { type: 'string', required: true, description: 'Payment method id to disable', source: 'from_previous_step', from: 'payment_methods[].id' },
  },
  response: {
    id: { type: 'string', description: 'Payment method id' },
    status: { type: 'string', description: 'DISABLED' },
  },
  example: {
    command: 'agenzo-token-cli payment-methods disable --id pm_abc123 --format json',
    output_summary: 'Disables the payment method and revokes any active tokens.',
  },
  error_recovery: {
    NOT_FOUND: 'Payment method id does not exist. Check the id with `payment-methods list`.',
    ALREADY_DISABLED: 'Card is already disabled. No action needed.',
  },
};

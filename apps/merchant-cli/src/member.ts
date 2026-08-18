/**
 * Shared `--member <id>` attribution flag (order write + list verbs).
 *
 * `member_id` is an OPTIONAL, caller-supplied end-user label. The platform
 * stores it and filters by it; it is never registered, validated for existence
 * or used as an ownership boundary (ownership stays `developer_id` +
 * `organization_id`, both derived server-side from the API Key). See
 * `doc/member-id-attribution-design.md`.
 *
 * Why one module: the same description, the same trimming rule and the same
 * `source: 'session'` schema entry are needed by 7 verbs across 4 nouns. Keeping
 * them here means the attribution semantics are stated once.
 *
 * `source: 'session'` marks the flag as supplied by the EXECUTION layer (the
 * orchestrator injects the authenticated end-user id), so it is hidden from the
 * LLM tool schema — an agent must not be able to choose whose orders it writes
 * or reads.
 */
import type { Command } from 'commander';
import type { FlagSchema } from './verb-schema.js';

/** Option description — identical wording on every verb that accepts it. */
export const MEMBER_OPTION_DESCRIPTION =
  'End-user member id this order is attributed to (optional, max 128 chars). '
  + 'On write it is stored on the order; on list it filters to that member only '
  + '(orders without a member_id are excluded).';

/** Verb-schema entry for the `member` flag. Hidden from LLM tool schemas. */
export const MEMBER_FLAG_SCHEMA: FlagSchema = {
  type: 'string',
  required: false,
  source: 'session',
  description: MEMBER_OPTION_DESCRIPTION,
  constraints: '1-128 characters; any character set. Omit to keep the order unattributed.',
};

/** Register `--member <id>` on a command. */
export function attachMemberOption(cmd: Command): Command {
  return cmd.option('--member <id>', MEMBER_OPTION_DESCRIPTION);
}

/**
 * Read `--member` from parsed options, trimmed. Returns `undefined` when absent
 * or blank so callers omit the field entirely rather than sending `""` (the
 * platform rejects an empty/blank `member_id` with 422 — a caller that meant to
 * attribute an order must not silently get an unattributed one).
 */
export function memberIdOf(opts: Record<string, unknown>): string | undefined {
  const raw = opts.member;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

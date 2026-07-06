import { Command } from 'commander';

/**
 * Map of `cli_noun` → the verb names this CLI binary actually registers.
 *
 * This is the CLI's local source of truth for "what can I execute". It is built
 * by introspecting the commander program's command tree — NOT from any bundled
 * schema. The discovery gate intersects backend capabilities against this map so
 * the Agent never sees a service/verb the local CLI cannot run.
 */
export type LocalCapabilityMap = Record<string, string[]>;

/** Command groups that are NOT discoverable services (utility groups). */
const NON_SERVICE_NOUNS = new Set(['services', 'help', 'config']);

/**
 * Build the local capability map from the commander program: each top-level
 * command group (noun) → its registered subcommand (verb) names.
 *
 * Excludes utility groups (e.g. `services` itself) and any command with no
 * subcommands (those are not service nouns).
 */
export function buildLocalCapabilityMap(program: Command): LocalCapabilityMap {
  const map: LocalCapabilityMap = {};
  for (const noun of program.commands) {
    const name = noun.name();
    if (NON_SERVICE_NOUNS.has(name)) continue;
    const verbs = noun.commands.map((v) => v.name()).filter((n) => n !== 'help');
    if (verbs.length === 0) continue;
    map[name] = verbs;
  }
  return map;
}

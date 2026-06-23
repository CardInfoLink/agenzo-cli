/**
 * Structured result envelope returned by every command handler.
 *
 * Handlers build a `CommandResult` on success and hand it to the central
 * renderer (`formatter/output.ts`), which switches between `--format json`
 * (machine payload) and `--format table` (human projection).
 */
export interface CommandResult<T = unknown> {
  /** Machine-readable payload emitted verbatim on `--format json`. */
  data: T;
  /** Lazy human presenter for `--format table`. Pure string builder, no I/O. */
  text: () => string;
  /** Optional one-line success note written to stderr (e.g. "Signed in"). Not part of stdout. */
  note?: string;
}

# Contracts

This directory holds the **error-code catalog** that `agenzo-cli` validates
against. `agenzo-cli` is a TypeScript client of the Agenzo backend; the only
thing it needs from the backend's error layer is the set of canonical
`error.code` values it may receive. That set is captured here as a JSON
snapshot rather than fetched at build time, so the build never depends on
network access.

## `error-codes.json`

A snapshot of the backend's canonical error catalog: every error code the API
can return, with its numeric `code`, HTTP status, and default message.

The contract check (`scripts/check-error-codes.mjs`, run via
`npm run check:error-codes`) verifies that every backend `error.code` the CLI
references in its production source is present in this snapshot's `codes` set.
A code referenced by the CLI but missing from the catalog ("orphan code") fails
the check — that usually means a typo in the CLI or a stale snapshot.

### Updating the snapshot

The snapshot is a **manual, explicit-PR artifact**: it is not auto-fetched, so
every catalog change stays visible and reviewable in a diff. When the backend's
error catalog changes:

1. Update `contracts/error-codes.json` to match the new catalog.
2. Open a PR. Reviewers see exactly which codes were added, removed, or
   renumbered.
3. Run `npm run check:error-codes` and reconcile any references it flags before
   merging.

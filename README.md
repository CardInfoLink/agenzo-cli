# agenzo-cli

> The command-line entry point to the Agenzo platform — the standard interface Agents use to call it.

`agenzo-cli` is a TypeScript monorepo (npm workspaces) that bundles the Agenzo CLIs and their shared core package. Agents (third-party Agents and first-party orchestration backends) integrate with the Agenzo platform exclusively through these CLIs; callers do not talk to the backend REST API directly.

The CLIs are built for both humans and AI Agents: human-readable `table` output by default, opt-in machine-readable `--format json`, stable exit codes, and a structured [SKILL.md](SKILL.md) that an Agent can load as context.

## Repository layout

```
agenzo-cli/
  packages/
    cli-core/                 # @agenzo/cli-core — the only shared dependency across CLIs
      api-client/             #   HTTP client + error mapping
      credential-store/       #   Bearer / OS-keychain credential storage
      key-store/              #   API key persistence
      formatter/              #   table (default) / json output
      prompt-engine/          #   interactive fallback prompts
      errors/                 #   SCREAMING_SNAKE_CASE error-code catalog
      version/                #   X-CLI-Min-Version negotiation
  apps/
    admin-cli/                # @agenzo/admin-cli    → bin: agenzo-admin-cli    (control plane / Bearer)
    token-cli/                # @agenzo/token-cli    → bin: agenzo-token-cli    (payment methods + tokens / API key)
    merchant-cli/             # @agenzo/merchant-cli → bin: agenzo-merchant-cli (merchant fulfillment / API key)
  contracts/                  # backend error-code catalog snapshot the CLI validates against
  scripts/                    # repo tooling (error-code contract check)
  doc/                        # per-CLI guides (admin / token / merchant)
```

## CLIs

| CLI | Package | Binary | Auth | Status |
|---|---|---|---|---|
| `admin-cli` | `@agenzo/admin-cli` | `agenzo-admin-cli` | Bearer token | Implemented |
| `token-cli` | `@agenzo/token-cli` | `agenzo-token-cli` | API key | Implemented |
| `merchant-cli` | `@agenzo/merchant-cli` | `agenzo-merchant-cli` | API key | Implemented |

- **admin-cli** — control plane: `auth` / `config` / `orgs` / `developers` / `keys` / `accounts`.
- **token-cli** — `payment-methods` (add payment method + 3DS) and `payment-tokens` (VCN / Network Token / X402).
- **merchant-cli** — `ride-elife` fulfillment (`quote` / `book` / `get` / `cancel` / `list-orders`).

## Conventions

- Each CLI has its own `package.json` and version and shares only `@agenzo/cli-core`. CLIs never import one another.
- `cli-core` is the single cross-cutting dependency.
- Output defaults to `--format table` (human-readable); Agents and scripts pass `--format json` (or set `AGENZO_FORMAT=json`). In json mode stdout carries exactly one payload value — logs, prompts, and errors go to stderr.
- Every server-side write accepts `--idempotency-key` (caller-supplied; the CLI never auto-generates one). It is forwarded verbatim as the `Idempotency-Key` header.
- Secrets (Bearer tokens, the one-time API key) never touch stdout.
- Exit codes: `0` success · `1` business error (4xx) · `2` CLI below the required minimum version · `3` auth failure · `4` upstream / 5xx.

## Command matrix

### admin-cli (control plane / Bearer token)

| Noun | Verbs |
|---|---|
| `auth` | `login` / `logout` |
| `config` | `set-host` / `show` / `reset-host` |
| `orgs` | `get` / `list` / `switch` / `update` |
| `developers` | `create` / `list` / `get` / `update` |
| `keys` | `create` / `list` / `get` / `rotate` / `disable` |
| `accounts` | `get` |

### token-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `payment-methods` | `add` / `list` / `get` / `disable` |
| `payment-tokens` | `create` / `list` / `get` / `revoke` |

### merchant-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `ride-elife` | `quote` / `book` / `get` / `cancel` / `list-orders` |

## Authentication

| Plane | CLI | Auth |
|---|---|---|
| Control plane | `agenzo-admin-cli` | Bearer token (via `auth login`) |
| Runtime plane | `agenzo-token-cli`, `agenzo-merchant-cli` | API key (`--api-key`) |

The default API host is `https://agent.everonet.com` (configurable with `agenzo-admin-cli config set-host`).

## Getting started

Requirements: Node.js 18+.

```bash
npm install              # install workspace dependencies
npm run build            # build cli-core + each app (tsup)
npm test                 # run the test suite (vitest)
npm run check:error-codes  # verify CLI error codes against the contract snapshot
```

Each app builds to its own `dist/index.js`, which is the entry point for the corresponding binary.

## For AI Agents

Load [SKILL.md](SKILL.md) into the agent context. It covers the end-to-end onboarding flow, the shared conventions, and links to the per-CLI guides:

- [doc/admin-cli.md](doc/admin-cli.md)
- [doc/token-cli.md](doc/token-cli.md)
- [doc/merchant-cli.md](doc/merchant-cli.md)

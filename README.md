# agenzo-cli

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

> The command-line entry point to the Agenzo platform — the standard interface Agents use to call it.

**[CLIs](#clis)** · **[Conventions](#conventions)** · **[Commands](#command-matrix)** · **[Authentication](#authentication)** · **[Getting started](#getting-started)** · **[For AI Agents](#for-ai-agents)**

`agenzo-cli` is the set of command-line tools for integrating with the Agenzo platform — the standard way developers and AI Agents manage payment methods, payment tokens, and merchant fulfillment.

## CLIs

| CLI | Package | Version | Binary | Auth | Status |
|---|---|---|---|---|---|
| `admin-cli` | `@agenzo/admin-cli` | [![npm](https://img.shields.io/npm/v/@agenzo/admin-cli.svg)](https://www.npmjs.com/package/@agenzo/admin-cli) | `agenzo-admin-cli` | Bearer token | Implemented |
| `token-cli` | `@agenzo/token-cli` | [![npm](https://img.shields.io/npm/v/@agenzo/token-cli.svg)](https://www.npmjs.com/package/@agenzo/token-cli) | `agenzo-token-cli` | API key | Implemented |
| `merchant-cli` | `@agenzo/merchant-cli` | [![npm](https://img.shields.io/npm/v/@agenzo/merchant-cli.svg)](https://www.npmjs.com/package/@agenzo/merchant-cli) | `agenzo-merchant-cli` | API key | Implemented |

- **admin-cli** — control plane: `auth` / `config` / `orgs` / `developers` / `keys` / `accounts`.
- **token-cli** — `payment-methods` (add payment method + 3DS) and `payment-tokens` (VCN / Network Token / X402).
- **merchant-cli** — merchant fulfillment: `services` (discover capabilities), `ride-elife` (ride-hailing), and `hotel-redaug` (international hotel booking via Redaug).

## Conventions

- Output defaults to `--format table`; Agents and scripts pass `--format json` (or set `AGENZO_FORMAT=json`). In json mode stdout carries exactly one payload value — logs, prompts, and errors go to stderr.
- Every server-side write accepts `--idempotency-key` (caller-supplied; the CLI never auto-generates one). It is forwarded verbatim as the `Idempotency-Key` header.
- Secrets (Bearer tokens, the one-time API key) never touch stdout.
- Exit codes: `0` success · `1` business error (4xx) · `2` CLI below the required minimum version · `3` auth failure · `4` upstream / 5xx · `5` user cancel.

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

`developers create` options:
- `--developer-name <name>` — developer name
- `--developer-email <email>` — developer email
- `--billing-mode <mode>` — `pay_per_call` (default) or `monthly_settlement`
- `--settlement-currency <code>` — ISO 4217 currency for the settlement account (e.g. `USD`, `CNY`). Only meaningful for `monthly_settlement`. Defaults to platform setting (`USD`) when omitted.
- `--idempotency-key <key>` — required for safe retry

### token-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `payment-methods` | `add` / `list` / `get` / `disable` |
| `payment-tokens` | `create` / `list` / `get` / `revoke` |

### merchant-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `services` | `list` / `get` |
| `ride-elife` | `quote` / `book` / `get` / `cancel` / `list-orders` |
| `hotel-redaug` | `find-destination` / `hotel-filters` / `list-cities` / `search` / `hotel-detail` / `quote` / `book` / `get` / `cancel` / `checkout` / `get-checkout` / `list-orders` |

`services list` discovers available capabilities from the platform backend, gated against the CLI's own registered commands (services/verbs the CLI cannot execute are hidden). `services get <service-id>` returns the full schema for a service (Agent reads this to learn how to use it).

`hotel-redaug` typical workflow: `find-destination` → `search` → `hotel-detail` (optional) → `quote` → `book` → `get` (poll until CONFIRMED) → `cancel` / `checkout` (optional).

## Authentication

| Plane | CLI | Auth |
|---|---|---|
| Control plane | `agenzo-admin-cli` | Bearer token (via `auth login`) |
| Runtime plane | `agenzo-token-cli`, `agenzo-merchant-cli` | API key (`--api-key`) |

The default API host is `https://agent.everonet.com` (production). To use the test environment, run `agenzo-admin-cli config set-host https://agent-dev.agenzo.com`.

## Getting started

Requires Node.js 22+. Install the CLIs from npm:

```bash
npm install -g @agenzo/admin-cli @agenzo/token-cli @agenzo/merchant-cli
```

Then sign in, create a developer, and mint an API key — after which the runtime CLIs work with `--api-key`:

```bash
agenzo-admin-cli auth login --email you@example.com               # sign in (magic link)
agenzo-admin-cli developers create --developer-name "my-bot" \
  --developer-email you@example.com \
  --billing-mode monthly_settlement \
  --settlement-currency CNY \
  --idempotency-key <key>
agenzo-admin-cli keys create --developer-id <dev_id> \
  --key-name "Prod Key" --scope token,merchant --idempotency-key <key>
# the one-time key is shown once — save it, then:
agenzo-token-cli payment-methods list --api-key <key>
agenzo-merchant-cli services list --api-key <key>
agenzo-merchant-cli hotel-redaug find-destination --keyword "上海" --api-key <key>
```

See [SKILL.md](SKILL.md) and the per-CLI guides below for the full onboarding flow and every command.

## For AI Agents

Load [SKILL.md](SKILL.md) into the agent context. It covers the end-to-end onboarding flow, the shared conventions, and links to the per-CLI guides:

- [doc/admin-cli.md](doc/admin-cli.md)
- [doc/token-cli.md](doc/token-cli.md)
- [doc/merchant-cli.md](doc/merchant-cli.md)

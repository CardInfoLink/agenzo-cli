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
| `payment-cli` | `@agenzo/payment-cli` | [![npm](https://img.shields.io/npm/v/@agenzo/payment-cli.svg)](https://www.npmjs.com/package/@agenzo/payment-cli) | `agenzo-payment-cli` | API key | Implemented |
| `merchant-cli` | `@agenzo/merchant-cli` | [![npm](https://img.shields.io/npm/v/@agenzo/merchant-cli.svg)](https://www.npmjs.com/package/@agenzo/merchant-cli) | `agenzo-merchant-cli` | API key | Implemented |

- **admin-cli** — control plane: `auth` / `config` / `orgs` / `developers` / `keys` / `accounts`.
- **token-cli** — `payment-methods` (add payment method: Evo 3DS or UnionPay enrollment) and `payment-tokens` (VCN / Network Token / X402).
- **payment-cli** — capture (charge) a previously created payment token (`capture pay`). Amount / currency / fee are taken from the token; payment brand is auto-detected.
- **merchant-cli** — merchant fulfillment: `services` (discover capabilities) and `ride-elife` (ride-hailing, the capability available today).

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

### token-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `payment-methods` | `add` / `list` / `get` / `disable` |
| `payment-tokens` | `create` / `list` / `get` / `revoke` |

**Payment brands** (selected via `--payment-brand` on `payment-methods add`):
- `evo` (default): Evo 3DS card binding — user verifies via email/browser.
- `unionpay`: UnionPay enrollment — user authenticates via passkey on a UnionPay-hosted page.

### payment-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `capture` | *(top-level command)* |

Captures (charges) a previously created payment token. Amount / currency / fee are fixed at token creation time — `capture` only submits the charge. The platform auto-detects the payment brand (`evo` or `unionpay`) from the token record.

### merchant-cli (runtime plane / API key)

| Noun | Verbs |
|---|---|
| `ride-elife` | `quote` / `book` / `get` / `cancel` / `list-orders` |

## Authentication

| Plane | CLI | Auth |
|---|---|---|
| Control plane | `agenzo-admin-cli` | Bearer token (via `auth login`) |
| Runtime plane | `agenzo-token-cli`, `agenzo-payment-cli`, `agenzo-merchant-cli` | API key (`--api-key`) |

The default API host is `https://agent.everonet.com` (production). To use the test environment, run `agenzo-admin-cli config set-host https://agent-dev.agenzo.com`.

## Getting started

Requires Node.js 22+. Install the CLIs from npm:

```bash
npm install -g @agenzo/admin-cli @agenzo/token-cli @agenzo/payment-cli @agenzo/merchant-cli
```

Then sign in, create a developer, and mint an API key — after which the runtime CLIs work with `--api-key`:

```bash
agenzo-admin-cli auth login --email you@example.com               # sign in (magic link)
agenzo-admin-cli developers create --developer-name "my-bot" \
  --developer-email you@example.com --idempotency-key <key>
agenzo-admin-cli keys create --developer-id <dev_id> \
  --key-name "Prod Key" --scope token,payment,merchant --idempotency-key <key>
# the one-time key is shown once — save it, then:
agenzo-token-cli payment-methods add --api-key <key> --payment-brand evo ...
agenzo-token-cli payment-tokens create --api-key <key> --payment-method-id <pm_id> ...
agenzo-payment-cli capture --api-key <key> --payment-token-id <ptk_id> \
  --idempotency-key <unique> --yes
```

See [SKILL.md](SKILL.md) and the per-CLI guides below for the full onboarding flow and every command.

## For AI Agents

Load [SKILL.md](SKILL.md) into the agent context. It covers the end-to-end onboarding flow, the shared conventions, and links to the per-CLI guides:

- [doc/admin-cli.md](doc/admin-cli.md)
- [doc/token-cli.md](doc/token-cli.md)
- [doc/payment-cli.md](doc/payment-cli.md)
- [doc/merchant-cli.md](doc/merchant-cli.md)

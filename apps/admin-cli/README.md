# @agenzo/admin-cli

[![npm](https://img.shields.io/npm/v/@agenzo/admin-cli.svg)](https://www.npmjs.com/package/@agenzo/admin-cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

> The **control-plane CLI** for the Agenzo platform. Operators and Agents use it to sign in, manage organizations, developers, API keys, and settlement accounts, and to point the toolchain at an environment.

**[Installation](#installation)** · **[Authentication](#authentication)** · **[Config](#environment-configuration)** · **[Commands](#command-matrix)** · **[keys](#keys)** · **[Idempotency](#idempotency)** · **[Errors](#output-and-errors)**

Binary: `agenzo-admin-cli` ｜ Auth: Bearer Token (via `auth login`)

## Installation

```bash
npm install -g @agenzo/admin-cli
```

The `agenzo-admin-cli` command is available after installation. Requires Node.js ≥ 22. Upgrade later with `npm install -g @agenzo/admin-cli@latest`.

## Authentication

admin-cli is a **control-plane** tool. Sign in once with a magic link; the resulting Bearer Token is stored locally and reused by every other command:

```bash
agenzo-admin-cli auth login --email you@example.com --idempotency-key <unique_key>
```

- First-time emails are auto-registered (prompts for an organization name, and an invitation code if the platform requires one).
- The CLI sends a magic link and polls until you click it (up to 10 minutes).
- Bearer Tokens (`access_token` / `refresh_token`) are stored under `~/.agenzo-admin-cli/` and **never printed to stdout**. Expired sessions are refreshed (or re-authenticated) automatically.
- The Bearer Token and the API Keys minted by `keys create` are **not interchangeable**: API Keys are for the runtime-plane CLIs ([`@agenzo/token-cli`](https://www.npmjs.com/package/@agenzo/token-cli) and friends).

## Environment configuration

admin-cli **owns** the environment for the whole toolchain. The host and path it writes to `~/.agenzo-admin-cli/config.json` are shared by the runtime-plane CLIs. The default target is production `https://agent.everonet.com`.

```bash
agenzo-admin-cli config set-host https://agent-dev.agenzo.com   # switch to the test environment
agenzo-admin-cli config set-host production                        # built-in profile name
agenzo-admin-cli config show                                       # show host / path / active org
agenzo-admin-cli config reset-host                                 # back to production default
```

Changing the host auto-selects a stored credential matching that host (clearing the active org when none match, so you never act against the wrong environment).

## Global options

| Option | Description |
|---|---|
| `--format <json\|table>` | Output format. Defaults to `table`; pass `json` (or set `AGENZO_FORMAT=json`) for machine-readable output |
| `--yes` | Skip interactive prompts (non-interactive automation) |
| `--verbose` | Print verbose logs to stderr |
| `--version` | Print the CLI version |

> Status, progress, and prompt lines for write operations go to stderr; under `--format json`, stdout emits structured data only (status lines are silenced). Exit code `0` on success, `1`–`5` for different error categories (see [Output and errors](#output-and-errors)).

## Command matrix

19 commands across 6 nouns. All server-facing commands authenticate with the stored Bearer Token; `config` and the local `orgs` verbs are pure-local (no network).

| Noun | Verb | Purpose | Write/Read |
|---|---|---|---|
| `auth` | `login` | Magic-link sign-in (auto-registers new emails) | W |
| `auth` | `logout` | Sign out of the active organization (local) | W |
| `config` | `set-host <host>` | Set API host (URL or profile name); local only | W |
| `config` | `show` | Show current host / path / active org; local only | R |
| `config` | `reset-host` | Reset host to the production default; local only | W |
| `orgs` | `get` | Show the current organization | R |
| `orgs` | `update` | Update org name / email (email change needs verification) | W |
| `orgs` | `list` | List signed-in orgs for the current host (local) | R |
| `orgs` | `switch <org_id>` | Switch the active organization (local) | W |
| `developers` | `create` | Create a developer (with billing mode) | W |
| `developers` | `list` | List developers | R |
| `developers` | `get <developer_id>` | Show a single developer | R |
| `developers` | `update <developer_id>` | Update a developer's name / email | W |
| `keys` | `create` | Mint an API Key (one-time plaintext, scoped) | W |
| `keys` | `list` | List API Keys for a developer (metadata only) | R |
| `keys` | `get <key_id>` | Show a single API Key (metadata only) | R |
| `keys` | `rotate <key_id>` | Rotate an API Key (new one-time plaintext) | W |
| `keys` | `disable <key_id>` | Permanently disable an API Key | W |
| `accounts` | `get` | Query a developer's settlement account | R |

## auth

### login — magic-link sign-in

```bash
agenzo-admin-cli auth login --email you@example.com --idempotency-key <unique_key>
```

| Flag | Required | Description |
|---|---|---|
| `--email` | Yes | Prompted interactively when omitted |
| `--idempotency-key` | Yes | Forwarded verbatim as the `Idempotency-Key` header on login/registration; prompted when omitted (required explicitly under `--yes`) |

Probes whether the email is registered; unknown emails branch to registration (prompts for organization name, and an invitation code if the platform returns one). Then polls the magic-link status (3s interval, 10 min timeout) and stores the credential on success. In `json` mode the payload is `{ organization_id, organization: { id, name }, email }` — tokens are never included.

### logout

```bash
agenzo-admin-cli auth logout
```

Best-effort server logout, then deletes the active org's local credential. Errors with `AUTH_NOT_SIGNED_IN` (exit 3) when not signed in. Local-only write — does **not** accept `--idempotency-key`.

## config

All `config` verbs are pure-local and make no HTTP calls.

### set-host

```bash
agenzo-admin-cli config set-host <host>
```

`<host>` is a full URL (`https://...`) or a built-in profile name (e.g. `production`, `testing`). Public `http://` is rejected; only `http://localhost` / `http://127.0.0.1` are allowed for local development. Writes `api_host` and auto-switches the active org to a credential matching the resolved host (clearing it when none match).

### show

```bash
agenzo-admin-cli config show [--format json]
```

Outputs `{ api_host, api_path, active_org }`. `active_org` is `null` (json) / `(none)` (table) when not signed in.

### reset-host

```bash
agenzo-admin-cli config reset-host
```

Equivalent to `set-host https://agent.everonet.com`; same auto-switch behavior.

## orgs

### get

```bash
agenzo-admin-cli orgs get [--format json]
```

`GET /organizations/me`. Returns the current `Organization` (`id`, `name`, `email`, `status`, `created_at`, `updated_at`).

### update

```bash
agenzo-admin-cli orgs update --name "Acme Inc." --idempotency-key <unique_key>
agenzo-admin-cli orgs update --email ops@acme.com --idempotency-key <unique_key>
```

| Flag | Required | Description |
|---|---|---|
| `--name` | No | New organization name |
| `--email` | No | New email — triggers an email-verification flow instead of an inline change |
| `--idempotency-key` | Yes | Forwarded as the `Idempotency-Key` header; prompted when omitted (required under `--yes`) |

A name-only change returns the updated `Organization`. An email change does **not** update inline: the platform issues a verification email and the CLI renders `Status: PENDING_EMAIL_VERIFICATION` plus an expiry. The underlying `magic_link_token` is deliberately withheld from output.

### list

```bash
agenzo-admin-cli orgs list [--format json]
```

Lists signed-in orgs **for the current host** (cross-environment credentials are filtered out); the active org is marked with `*` (table) / `active: true` (json). Local-only — no network.

### switch

```bash
agenzo-admin-cli orgs switch <org_id>
```

Sets the active org. Fails if the org is not signed in locally, or belongs to a different environment (cross-environment guard). Local-only write — does **not** accept `--idempotency-key`.

## developers

### create

```bash
agenzo-admin-cli developers create \
  --developer-name "shopping-bot" \
  --developer-email oncall@acme.com \
  --billing-mode pay_per_call \
  --idempotency-key <unique_key>
```

| Flag | Required | Description |
|---|---|---|
| `--developer-name` | Yes | Prompted when omitted |
| `--developer-email` | Yes | Prompted when omitted |
| `--billing-mode` | No | `pay_per_call` (default) or `monthly_settlement`; validated locally (invalid → `PARAM_INVALID`, exit 1) |
| `--idempotency-key` | Yes | Forwarded as the `Idempotency-Key` header; prompted when omitted (required under `--yes`) |

`POST /developers/create`. Returns the `Developer` (including `billing_mode`). A `monthly_settlement` developer also gets a settlement account provisioned server-side (queryable via `accounts get`); `pay_per_call` does not.

### list

```bash
agenzo-admin-cli developers list [--format json]
```

`GET /developers`. Table columns: `ID / Name / Email / Status`; prints `No developers found` when empty.

### get

```bash
agenzo-admin-cli developers get <developer_id> [--format json]
```

`GET /developers/{id}`. Includes `billing_mode`, `created_at`, `updated_at`.

### update

```bash
agenzo-admin-cli developers update <developer_id> --name "shopping-bot-prod" --idempotency-key <unique_key>
```

| Flag | Required | Description |
|---|---|---|
| `--name` | No | New name |
| `--email` | No | New email |
| `--idempotency-key` | Yes | Forwarded as the `Idempotency-Key` header; prompted when omitted (required under `--yes`) |

`POST /developers/{id}/update`. Returns the updated `Developer`.

## keys

API Keys are issued per developer and authorize the runtime-plane CLIs. The plaintext key is shown **only once**, at create/rotate time.

### create

```bash
agenzo-admin-cli keys create \
  --developer-id <developer_id> \
  --key-name "Production Key" \
  --scope token,merchant,payment \
  --idempotency-key <unique_key>
```

| Flag | Required | Description |
|---|---|---|
| `--developer-id` | Yes | Owning developer; prompted when omitted |
| `--key-name` | Yes | Display name for the key; prompted when omitted |
| `--scope` | No | Comma-separated subset of `token`, `merchant`, `payment` (which runtime CLIs the key may call). Defaults to all three; validated locally |
| `--idempotency-key` | Yes | Forwarded as the `Idempotency-Key` header; prompted when omitted (required under `--yes`) |

`POST /keys/create`. The one-time `api_key` is part of the `json` payload, and in `table` mode is printed to stderr with a "save it now" warning. Save it immediately — it cannot be retrieved later.

### list

```bash
agenzo-admin-cli keys list --developer-id <developer_id> [--format json]
```

`GET /keys`. Columns: `ID / Developer / Name / Scope / Status / Last Used`. The plaintext key is stripped — read commands never expose secrets.

### get

```bash
agenzo-admin-cli keys get <key_id> [--format json]
```

`GET /keys/{id}`. Metadata only (no plaintext key).

### rotate

```bash
agenzo-admin-cli keys rotate <key_id> --idempotency-key <unique_key>
```

`POST /keys/{id}/rotate`. Invalidates the old value and returns a new one-time `api_key` (same one-time handling as `create`). `--idempotency-key` is prompted when omitted (required under `--yes`).

### disable

```bash
agenzo-admin-cli keys disable <key_id> --idempotency-key <unique_key>
```

`POST /keys/{id}/disable`. Permanently disables the key and prints its `Status`. `--idempotency-key` is prompted when omitted (required under `--yes`).

## accounts

### get — query a settlement account

```bash
agenzo-admin-cli accounts get --developer-id <developer_id> [--format json]
```

`GET /accounts?developer_id=...`. Returns the developer's `SettlementAccount` (`id`, `developer_id`, `balance`, `currency`, `status`, timestamps). Developers on `pay_per_call` (no account) return `account: null` with an info line — only `monthly_settlement` developers have an account.

## Idempotency

Every **server-side write** must be idempotent. These 7 commands require `--idempotency-key`:

`auth login` · `orgs update` · `developers create` · `developers update` · `keys create` · `keys rotate` · `keys disable`

- The CLI **never auto-generates** the key — the caller supplies a unique value per logical request. It is forwarded verbatim as the `Idempotency-Key` HTTP header (never in the body); retrying with the same value safely returns the first result.
- When omitted in interactive mode, the CLI prompts for it. Under `--yes` (non-interactive), a missing key fails fast with `PARAM_IDEMPOTENCY_KEY_REQUIRED` (exit 1) before any network call.
- The pure-local writes (`auth logout`, `config set-host`, `config reset-host`, `orgs switch`) do **not** accept `--idempotency-key`.

## Output and errors

- **Success**: `table` mode prints formatted text to stdout; `json` mode emits the structured payload to stdout and silences status lines.
- **Failure**: an error envelope is written to stderr. In `json` mode it is `{ "error": { "code", "code_num", "message", "request_id?" } }`; in `table` mode it is `✗ [<code_num>] <message>`.
- **Secrets**: Bearer Tokens never reach stdout in any format; API Key plaintext is shown only once on create/rotate, and stripped from all read commands.
- **Exit codes**: `0` success · `1` business / parameter (4xx) · `2` upgrade required · `3` auth failure / invalid · `4` network / 5xx · `5` user cancel.

Common error codes: `AUTH_NOT_SIGNED_IN`, `AUTH_SESSION_EXPIRED`, `AUTH_TIMEOUT` (magic-link not clicked in time), `ORG_CONFLICT` (name/email taken), `ORG_NOT_FOUND`, `KEY_NOT_FOUND`, `PARAM_INVALID`, `PARAM_IDEMPOTENCY_KEY_REQUIRED`, `RATE_LIMITED`, `UPGRADE_REQUIRED`.

## Local state

All state lives under `~/.agenzo-admin-cli/`:

- `config.json` — `api_host` / `api_path` / `active_org`
- `credentials/<org_id>.json` — Bearer Tokens (never printed to stdout)
- `keys.json` — one-time API Key cache (written on create/rotate)

## Related

- Runtime plane (payment methods / payment tokens): [`@agenzo/token-cli`](https://www.npmjs.com/package/@agenzo/token-cli).

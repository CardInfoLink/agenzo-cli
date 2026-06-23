# @agenzo/merchant-cli

> **Merchant-fulfillment product-line CLI** — binary `agenzo-merchant-cli`, lives in the monorepo `agenzo-cli/apps/merchant-cli`.
> Covers two noun groups: capability discovery (`services`) and the ride-hailing business loop (`ride-elife`), 7 commands in total.

---

## Overview

`agenzo-merchant-cli` is the command-line entry point for Agents to access Agenzo's merchant-fulfillment capabilities. This iteration ships two noun groups:

- **`services`** (capability discovery): lets an Agent discover available merchant-fulfillment capabilities (which noun/verb to call, and the call flow). The data source this iteration is the **CLI-bundled registry** (the backend `/services` discovery endpoint is pending impl).
- **`ride-elife`** (ride hailing, the only online provider): the full loop of quote → book → query/poll → cancel → list-orders.

All shared infrastructure (HTTP client, output rendering, error system, exit codes, version negotiation, config) is reused from `@agenzo/cli-core`; the app only keeps command handling and merchant-domain-specific logic (ride body assembly, NDJSON watch, verb-schema help, services registry, idempotency-key policy).

> This CLI keeps its structure, naming, and build configuration consistent with `agenzo-admin-cli` / `agenzo-token-cli` (4-CLI consistency).

## Features

| Noun | Verb | Type | HTTP | Description |
|---|---|---|---|---|
| `services` | `list` | Read | — (bundled registry) | List available merchant-fulfillment capabilities |
| `services` | `get <service-id>` | Read | — (bundled registry) | View the full metadata of a single capability (miss → `SERVICE_NOT_FOUND`) |
| `ride-elife` | `quote` | Read | `POST /ride/quote` | Point-to-point quote (`vehicle_classes[]` + meet-and-greet) |
| `ride-elife` | `book` | Write/Y | `POST /ride/book` | Book against a quote (monthly_settlement-aware, see below) |
| `ride-elife` | `get` | Read | `GET /ride/<id>/status` | Query order status; `--watch` emits an NDJSON polling stream |
| `ride-elife` | `cancel` | Write/Y | `POST /ride/<id>/cancel` | Cancel an order (no body, may incur a fee) |
| `ride-elife` | `list-orders` | Read | `GET /ride/orders` | List booked trips (pagination + filtering) |

> Write commands (`book` / `cancel`) are subject to the idempotency-key rules (see [Idempotency-Key](#idempotency-key)).
> Not implemented: `ride-elife track` (pending impl, the backend has no location-stream interface) — `get --watch` already covers order-status polling.

## Tech Stack

- TypeScript (ESM) + [commander@14](https://github.com/tj/commander.js) + [@inquirer/prompts](https://github.com/SBoudrias/Inquirer.js)
- Build: [tsup](https://tsup.egoist.dev/) (esm / node18 / dts, banner `#!/usr/bin/env node`)
- Testing: [vitest](https://vitest.dev/) + [fast-check](https://fast-check.dev/) (PBT)
- Shared base package: `@agenzo/cli-core` (the only horizontal dependency; importing other apps is **forbidden**)

## Quick Start

### Requirements

- Node.js 18+
- `npm install` has been run in the monorepo

### Build

```bash
# in the monorepo root
npm run build -w @agenzo/cli-core       # must build the shared base package first
npm run build -w @agenzo/merchant-cli   # tsup produces dist/index.js (= bin agenzo-merchant-cli)
agenzo-merchant-cli --version
```

### Authentication

A runtime-plane CLI that uses an **API Key** (`--api-key`, carried per command as the `X-Api-Key` header):

- The API Key is issued by `agenzo-admin-cli keys create --scope merchant` and must include the `merchant` scope.
- When `--api-key` is omitted, it is requested interactively (password input).
- No Bearer Token / AuthService / keystore — consistent with `agenzo-token-cli`.

### End-to-end example

```bash
# 1. Discover capabilities
agenzo-merchant-cli services list
agenzo-merchant-cli services get ride-elife

# 2. Quote (produces quote_id)
agenzo-merchant-cli ride-elife quote --api-key "$API_KEY" \
  --pickup-lat 37.7937 --pickup-lng -122.3956 --pickup-name "1 Market St" \
  --dropoff-lat 37.6213 --dropoff-lng -122.3790 --dropoff-name "SFO Airport" \
  --pickup-time now

# 3. Book (write op: --yes auto-confirms + --idempotency-key must be provided)
agenzo-merchant-cli ride-elife book --api-key "$API_KEY" --yes \
  --quote-id "$QUOTE_ID" --vehicle-class Sedan --price-amount 42.50 \
  --passenger-name "Alice" --passenger-phone "+14155551234" \
  --idempotency-key "book-$(date +%s)"

# 4. Query / poll (--watch emits line-by-line NDJSON)
agenzo-merchant-cli ride-elife get --api-key "$API_KEY" --order-id "$RIDE_ID"
agenzo-merchant-cli ride-elife get --api-key "$API_KEY" --order-id "$RIDE_ID" \
  --watch --watch-interval 5 --watch-timeout 600

# 5. List orders / cancel
agenzo-merchant-cli ride-elife list-orders --api-key "$API_KEY" --status Pending --page 1 --page-size 20
agenzo-merchant-cli ride-elife cancel --api-key "$API_KEY" --yes \
  --order-id "$RIDE_ID" --idempotency-key "cancel-$(date +%s)"
```

## Global flags

| Flag | Default | Description |
|---|---|---|
| `--format <json\|table>` | **`json`** | Output format. merchant-cli is an agent-first entry point, so it **defaults to `json`** (a deliberate deviation from cli-core's `table` default, D2); also reads the `AGENZO_FORMAT` environment variable |
| `--api-key <key>` | — (requested interactively) | API Key, carried per command as the `X-Api-Key` header |
| `--yes` | `false` | Skip interactive confirmation (for CI / Agent); for write commands, `--yes` with a missing idempotency key is a hard error |
| `--verbose` | `false` | Verbose logging (written to stderr) |

## Output and error contract

- **`--format json` (non-watch commands)**: stdout contains only a **single valid JSON** (business payload + `profile`/`endpoint` envelope, where endpoint is host-only without a path); all status/progress/spinner lines go to stderr and are silenced in json mode.
- **`--format table`**: business output goes to stdout, status lines/spinner go to stderr.
- **`get --watch`**: stdout is a line-by-line NDJSON stream, **not wrapped** in the profile/endpoint envelope; polling stops when it hits the terminal-status set (`At destination` / `Cancelled` / `Rejected` / `Customer no show` / `Driver no show`, case-sensitive) or times out; on timeout the final line is `{ "watch_status": "timeout", ... }`.
- **Error envelope** (cli-core §8): `json` → `{ "error": { "code", "code_num", "message", "request_id"? } }`; `table` → `✗ [<code_num>] <message>`.

Exit codes (mapped by cli-core's `exitCodeFor`):

| Exit code | Meaning | Representative error codes |
|---|---|---|
| `0` | Success | — |
| `1` | Business / param | `PARAM_INVALID`(2101) · `PARAM_IDEMPOTENCY_KEY_REQUIRED`(2102) · `SERVICE_NOT_FOUND`(4101) · `VEHICLE_UNAVAILABLE`(4201) · `QUOTE_EXPIRED`(4202) · `BOOKING_FAILED`(4203) · `CANCELLATION_NOT_ALLOWED`(4204) · `BILLING_MODE_MISMATCH`(3001) · `ACCOUNT_*`(31xx) · `PAYMENT_ORDER_*`(32xx) |
| `2` | Upgrade required | `UPGRADE_REQUIRED`(9008) |
| `3` | Auth / invalid key | `KEY_INVALID`(1101) · `KEY_SCOPE_DENIED`(1102) |
| `4` | Network / 5xx | `RATE_LIMITED`(5001) · `UPSTREAM_ERROR`(5101) · `INTERNAL_ERROR`(5201) |
| `5` | User cancel | `CLIENT_ABORTED`(9007) · SIGINT |

> api-key auth mapping: HTTP 401 → `KEY_INVALID`, 403 → `KEY_SCOPE_DENIED`. A known §8 string code returned by the backend (e.g. `QUOTE_EXPIRED`) takes priority and is preserved; otherwise it falls back to the HTTP-status mapping.

## Idempotency-Key

The write commands `ride-elife book` / `cancel` accept `--idempotency-key`:

- Format: `[A-Za-z0-9_-]{1,128}`.
- **The CLI never auto-generates one**: `--yes` with a missing key → hard error `PARAM_IDEMPOTENCY_KEY_REQUIRED` (exit 1), and no request is sent; a missing key without `--yes` → requested interactively.
- Sent as the `Idempotency-Key` HTTP **header**, **never in the body**.
- Reuse the same key to retry the same logical request; use a new key for a new request.

## Billing model for book (monthly_settlement-aware)

`ride-elife book` **does not accept** `--payment-method-id` or any card information — the merchant domain holds no payment handle. Funding is decided by the backend according to the Developer's `billing_mode`:

- **monthly_settlement**: deducted from the monthly-settlement account, no payment handle; the response has `payment_status=ON_ACCOUNT` and includes `billing_entry_id`.
- **pay_per_call**: optionally pass through `--payment-order-id` (a PAID order number charged separately, out-of-band); the response echoes `payment_order_id`.

The request body contains at most an optional `payment_order_id`.

## profile / host model

merchant-cli **has no host / config commands** and does not govern environments. It reuses `@agenzo/cli-core`'s `ConfigManager` default configuration (i.e. the environment governed centrally by `agenzo-admin-cli`, persisted by default to `~/.agenzo-admin-cli/`):

- Provides the `baseUrl` for `ApiClient` (host + `/api/merchant/v1`).
- Provides the environment name + host for the `profile` / `endpoint` envelope in json output.

**Environment governance (setting the host / switching environments) belongs to `agenzo-admin-cli`** (`agenzo-admin-cli config set` / `set-host`) — consistent with `agenzo-token-cli`.

## Machine-readable verb schema

Every `ride-elife` verb supports `--help --format json`, emitting that verb's machine-readable schema (`cli` / `noun` / `verb` / `description` / `flags` / `response` / `example`, some with `error_recovery` / `polling`):

```bash
agenzo-merchant-cli ride-elife quote --help --format json
agenzo-merchant-cli ride-elife book --help --format json
```

## Development

```bash
npm run build -w @agenzo/merchant-cli   # tsup build
npm run test  -w @agenzo/merchant-cli   # vitest (incl. fast-check PBT)
```

Source structure:

```text
apps/merchant-cli/
  src/
    index.ts                 # commander assembly + top-level reportError + SIGINT
    services/{list,get}.ts    # capability discovery (this iteration: CLI-bundled registry)
    services/registry.ts      # bundled static registry (merchant domain)
    ride-elife/{quote,book,get,cancel,list-orders}.ts
    ride-elife/watch.ts       # NDJSON polling engine (merchant domain)
    verb-schema.ts            # verb schema for --help --format json (merchant domain)
    idempotency.ts            # idempotency key resolve / normalize (merchant domain)
    types/api.ts              # ride/service response types (consumed by merchant only, not promoted to cli-core)
  docs/                       # test design docs (see below)
  tests/                      # vitest unit tests + PBT
```

## Documentation index

- [Test design doc (command matrix v1)](docs/test-design-command-matrix-v1.md) — a 7-command × requirement/Property coverage matrix, the L1–L4 layered testing strategy, L1 unit / L3 command-level case tables, and L4 manually executable smoke cases.
- Architecture and standards: `architecture-upgrade/v1/` (cli-standard / cli-design §4+§8 / cli-guide).
- monorepo overview: [`agenzo-cli/README.md`](../../README.md).

## Changelog

### 2026-06

- Landed merchant-cli in the monorepo `agenzo-cli/apps/merchant-cli` (rewritten per cli-design §4, reusing `@agenzo/cli-core`).
- Shipped `services` (list / get) + `ride-elife` (quote / book / get [+`--watch`] / cancel / list-orders), 7 commands in total.
- Output defaults to `json` (agent-first); API Key auth (`X-Api-Key`); write commands require `--idempotency-key`.
- Added the test design doc `docs/test-design-command-matrix-v1.md`.

# @agenzo/token-cli

[![npm](https://img.shields.io/npm/v/@agenzo/token-cli.svg)](https://www.npmjs.com/package/@agenzo/token-cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

> The **payment credential CLI** (runtime plane) for the Agenzo platform. Agents use it to manage payment methods (card details + 3DS verification) and to issue payment tokens (VCN / Network Token / X402) before a transaction.

**[Installation](#installation)** · **[Authentication](#authentication)** · **[Commands](#command-matrix)** · **[payment-methods](#payment-methods)** · **[payment-tokens](#payment-tokens)** · **[Errors](#output-and-errors)**

Binary: `agenzo-token-cli` ｜ Auth: API Key (`X-Api-Key`)

## Installation

```bash
npm install -g @agenzo/token-cli
```

The `agenzo-token-cli` command is available after installation. Requires Node.js ≥ 22. Upgrade later with `npm install -g @agenzo/token-cli@latest`.

## Authentication

token-cli is a **runtime-plane** tool. Every command authenticates with `--api-key <api_key>` (prompted interactively when omitted).

API Keys are issued by the control-plane tool [`agenzo-admin-cli`](https://www.npmjs.com/package/@agenzo/admin-cli):

```bash
agenzo-admin-cli keys create --developer-id <dev_id> --key-name "Prod Key" --scope token
```

- The key's scope must include `token`, otherwise calls return `KEY_SCOPE_DENIED`.
- API Keys and admin-cli's Bearer Token are **not interchangeable**.

## Environment configuration

token-cli reuses the environment configuration (API host / path) written by admin-cli; it has no environment-management commands of its own. The default target is production `https://agent.agenzo.com`. Switch environments via admin-cli:

```bash
agenzo-admin-cli config set-host https://agent-dev.agenzo.com   # switch to the test environment
agenzo-admin-cli config show                                       # show current host / path
```

## Global options

| Option | Description |
|---|---|
| `--format <json\|table>` | Output format. Defaults to `table`; pass `json` (or set `AGENZO_FORMAT=json`) for machine-readable output |
| `--yes` | Skip all confirmation prompts (non-interactive automation) |
| `--verbose` | Print verbose logs to stderr |
| `--version` | Print the CLI version |

> Prompts and logs for write operations go to stderr; under `--format json`, stdout emits structured data only. Exit code `0` on success, `1`–`5` for different error categories.

## Command matrix

| Noun | Verb | Purpose | Write/Read |
|---|---|---|---|
| `payment-methods` | `add` | Add a payment method: default opens the hosted binding page (Visa + Mastercard, no card details at the CLI); `--payment-brand unionpay` for UnionPay enrollment. Auto-polls to a terminal status | W |
| `payment-methods` | `list` | List payment methods under the current API Key | R |
| `payment-methods` | `get <pm_id>` | Show details of a single payment method | R |
| `payment-methods` | `disable <pm_id>` | Disable a payment method (cascades to revoke its issued tokens) | W |
| `payment-tokens` | `create` | Issue a payment token (VCN / Network Token / X402, pick one) | W |
| `payment-tokens` | `list` | List payment tokens under the current API Key | R |
| `payment-tokens` | `get <payment_token_id>` | Show details of a single payment token | R |
| `payment-tokens` | `revoke <payment_token_id>` | Revoke a payment token (X402 uses delayed revocation) | W |

## payment-methods

### add — add a payment method

Two paths, selected via `--payment-brand`:

- **`visa` / `mastercard` / omitted (default): hosted binding.** All three open the **same** hosted binding session (identical `Link URL`). The CLI never collects card details — it prints a `Link URL` and polls until the cardholder finishes in the browser. The hosted page detects the card brand and runs the matching rail — Visa (VTS self-mint + Payment Passkey) or Mastercard (EVO Drop-in) — both landing on the same PM. Passing `visa` or `mastercard` is an optional hint only; it does not change the URL.
- **`unionpay`**: UnionPay Agent Pay enrollment (returns an `Enroll URL`).

#### Hosted binding (default)

```bash
agenzo-token-cli payment-methods add \
  --api-key <api_key> \
  --email user@example.com \
  --member <member_id>            # optional
```

| Flag | Required | Description |
|---|---|---|
| `--api-key` | Yes | Prompted interactively when omitted |
| `--type` | No | Payment method type, defaults to `card` |
| `--email` | Yes | The hosted binding link is emailed here. A session reference / cardholder identity — **not** a card credential; never used to authenticate the card to Visa or Mastercard |
| `--member` | No | End-user this card belongs to. Optional at the CLI boundary; scopes the card so it appears under `list --member <id>` |

Returns a `PM ID` (PENDING) + `Link URL` immediately, then auto-polls verification (5s interval, 30 min timeout). The cardholder opens the Link URL, enters the card (Visa or Mastercard) and completes verification in the browser; card number / CVV / expiry never reach the CLI. On success prints `ACTIVE` + brand / first six / last four. On `FAILED` / `EXPIRED` / timeout it prints the `PM ID` and exits non-zero — re-run with the same `--email` to reuse the PENDING record.

#### UnionPay enrollment mode

```bash
agenzo-token-cli payment-methods add \
  --api-key <api_key> \
  --payment-brand unionpay \
  --member <member_id> \
  --email user@example.com \
  --return-url https://merchant.com/bind-done   # optional
```

| Flag | Required | Description |
|---|---|---|
| `--api-key` | Yes | Prompted interactively when omitted |
| `--payment-brand` | Yes | Set to `unionpay` |
| `--member` | Yes | End-user identity (must be stable across enrollment and token creation) |
| `--email` | Yes | Email associated with the binding |
| `--return-url` | No | Front-end redirect URL returned alongside the terminal status. Only for `--payment-brand unionpay`. Not sent to UnionPay — used by the caller for post-enrollment navigation |

Returns `Enroll URL` and polls for ACTIVE/FAILED (5s interval, 60s timeout). The user must open the Enroll URL in a browser to complete passkey authentication. Card details flags are not used.

### list

```bash
agenzo-token-cli payment-methods list --api-key <api_key> [--member <member_id>]
```

Outputs a table of `ID / Type / Brand / First 6 / Last 4 / Status`; prints `No payment methods found` when empty.

### get

```bash
agenzo-token-cli payment-methods get <pm_id> --api-key <api_key>
```

### disable

```bash
agenzo-token-cli payment-methods disable <pm_id> --api-key <api_key> [--idempotency-key <key>]
```

Disables the payment method and cascades to revoke its issued payment tokens, printing `Status` and the `Revoked tokens` count. `--idempotency-key` is required in `--yes` mode.

## payment-tokens

### create — issue a payment token

The three types branch via `--type`: `vcn` / `network-token` / `x402`.

```bash
# VCN (Virtual Card Number)
agenzo-token-cli payment-tokens create \
  --api-key <api_key> --type vcn \
  --payment-method-id <pm_id> \
  --amount 25.00 \
  --idempotency-key <unique_key>

# Network Token
agenzo-token-cli payment-tokens create \
  --api-key <api_key> --type network-token \
  --card 1234 \
  --idempotency-key <unique_key>

# X402 (on-chain USDC payment signature)
agenzo-token-cli payment-tokens create \
  --api-key <api_key> --type x402 \
  --payment-method-id <pm_id> \
  --amount 1.50 --pay-to 0x... --nonce <n> --network base-sepolia --deadline <unix_ts> \
  --idempotency-key <unique_key>
```

| Flag | Applies to | Description |
|---|---|---|
| `--api-key` | all | Prompted interactively when omitted |
| `--type` | all | `vcn` / `network-token` / `x402` |
| `--payment-method-id` | vcn / network-token | One of this or `--card`; takes priority over `--card` |
| `--card` | vcn / network-token | Match a payment method by its last 4 digits |
| `--member` | all | Associate a member (optional) |
| `--amount` | vcn / x402 | VCN: USD (`0.01`–`500.00`); X402: USDC amount |
| `--currency` | vcn | Omitted by default; the server applies its default currency |
| `--pay-to` / `--nonce` / `--network` / `--deadline` | x402 | Required X402 quadruple; `--deadline` is a Unix timestamp |
| `--external-tx-id` | all | Forwarded to the request body as `external_tx_id` (optional) |
| `--recipient-first-name` | network-token (unionpay) | Recipient first name for UnionPay order delivery details |
| `--recipient-last-name` | network-token (unionpay) | Recipient last name for UnionPay order delivery details |
| `--recipient-email` | network-token (unionpay) | Recipient email (one of email or phone required for unionpay) |
| `--recipient-phone` | network-token (unionpay) | Recipient phone (one of email or phone required for unionpay) |
| `--unionpay-amount` | network-token (unionpay) | Intent amount as decimal string (e.g. "174.58"), required for unionpay cards |
| `--return-url` | network-token (unionpay) | Front-end redirect URL returned alongside the terminal status. Not sent to UnionPay — used by the caller for post-payment navigation |
| `--idempotency-key` | all | **Required**; forwarded verbatim as the `Idempotency-Key` HTTP header, retrying the same key returns the first result |

> Before writing, the freeze amount and service fee are shown and confirmation is requested; `--yes` skips confirmation (in which case `--idempotency-key` must be supplied explicitly).

### list

```bash
agenzo-token-cli payment-tokens list --api-key <api_key> [--type <type>] [--member <member_id>]
```

### get

```bash
agenzo-token-cli payment-tokens get <payment_token_id> --api-key <api_key>
```

### revoke

```bash
agenzo-token-cli payment-tokens revoke <payment_token_id> --api-key <api_key> [--idempotency-key <key>]
```

Revokes immediately and prints `REVOKED` plus the revocation time; X402 tokens use delayed revocation (the cryptogram expires naturally), printing `ACTIVE` plus the expiry time. `--idempotency-key` is required in `--yes` mode.

## Output and errors

- **Success**: `table` mode prints formatted text; `json` mode emits the structured payload to stdout.
- **Failure**: an error envelope is written to stderr. In `json` mode it is `{ "error": { "code", "code_num", "message", "request_id?" } }`; in `table` mode it is `✗ [<code_num>] <message>`.
- **Exit codes**: `0` on success, `1`–`5` for different error categories (e.g. user cancellation = `5`).

Common error codes: `KEY_INVALID` (invalid API Key), `KEY_SCOPE_DENIED` (scope lacks `token`), `TOKEN_FEATURE_DISABLED` (token type not enabled), `PARAM_IDEMPOTENCY_KEY_REQUIRED` (missing `--idempotency-key`), `CLIENT_NO_PAYMENT_METHOD` / `CLIENT_CARD_NOT_MATCHED` (no usable payment method matched locally).

## Related

- Control plane (login / organizations / developers / API Key management): [`@agenzo/admin-cli`](https://www.npmjs.com/package/@agenzo/admin-cli).

# Agenzo CLI Skill

You are a payment & fulfillment integration assistant. Help users use the Agenzo CLIs to manage payment methods, payment tokens, and merchant fulfillment (rides, hotels, flights).

This file is the **index**: overview + shared conventions. Per-CLI command detail lives in the linked guides — read the relevant one for the task at hand.

## CLIs

Agenzo provides four command-line tools, split by product area:

| CLI | Package | Binary | Auth | Guide |
|---|---|---|---|---|
| `admin-cli` | `@agenzo/admin-cli` | `agenzo-admin-cli` | Bearer Token | [doc/admin-cli.md](doc/admin-cli.md) |
| `token-cli` | `@agenzo/token-cli` | `agenzo-token-cli` | API Key | [doc/token-cli.md](doc/token-cli.md) |
| `merchant-cli` | `@agenzo/merchant-cli` | `agenzo-merchant-cli` | API Key | [doc/merchant-cli.md](doc/merchant-cli.md) |
| `payment-cli` | `@agenzo/payment-cli` | `agenzo-payment-cli` | API Key | [doc/payment-cli.md](doc/payment-cli.md) |

- **admin-cli** (19 commands) — control plane: auth / config / orgs / developers / keys / accounts.
- **token-cli** (13 commands) — payment-methods (add + 3DS / Drop-in / UnionPay enrollment) and payment-tokens (VCN / Network Token / X402 / UnionPay checkout).
- **merchant-cli** (44 commands) — fulfillment: ride-elife (5), hotel-redaug (14), flight-flink (21), orders (2), services (2).
- **payment-cli** (1 command) — charge a previously-created payment token.

## Capability Overview

### Payment Methods & Tokens (token-cli)

Two paths for adding a payment method:

| Payment brand | Command | Result |
|---|---|---|
| Evo (Visa/MC) | `payment-methods add --payment-brand evo` | 3DS inline → ACTIVE |
| Evo Drop-in | `payment-methods add --mode dropin` | Session URL → poll |
| UnionPay | `payment-methods add --payment-brand unionpay --member <id>` | `enroll_url` → user authenticates → ACTIVE |

Three token types: `vcn` (single-use virtual card), `network-token` (tokenized credential + cryptogram), `x402` (HTTP 402 on-chain payment).

UnionPay network tokens require a separate checkout step (`payment-tokens unionpay-create`) that returns a `checkout_url` for user authentication.

### Merchant Fulfillment (merchant-cli)

| Service | Noun | Verbs | Typical Flow |
|---|---|---|---|
| Ride-hailing | `ride-elife` | quote, book, get, cancel, list-orders | quote → book → get (poll) |
| Hotels | `hotel-redaug` | find-destination, list-cities, hotel-filters, search, hotel-detail, quote, create-order, pay-order, get, cancel, checkout, get-checkout, list-orders, skill | search → quote → create-order → pay-order → get |
| Flights | `flight-flink` | find-airport, list-airports, list-airlines, list-nationalities, search, more-offers, verify, create-order, pay-order, get-order, cancel-order, change-search, change-apply, change-detail, change-pay, change-cancel, refund-apply, refund-detail, refund-confirm, list-orders, skill | search → verify → create-order → pay-order → get-order |
| Orders | `orders` | list, get | Cross-provider order history |
| Discovery | `services` | list, get | List available capabilities |

### Payments (payment-cli)

`payments capture` — charge a payment token. Amount/currency are fixed on the token at creation time; the command only takes `--payment-token-id` and `--idempotency-key`. Returns `amount_cents` (integer).

## Key Workflows

### End-to-end Onboarding

```
[admin-cli] auth login → developers create → keys create --scope token,merchant,payment
[token-cli] payment-methods add → payment-tokens create
[merchant-cli] ride-elife quote → book / hotel-redaug search → create-order → pay-order
[payment-cli] payments capture (for pay_per_call with pre-charged token)
```

### UnionPay Payment Method Enrollment + Payment

```
[token-cli]    payment-methods add --payment-brand unionpay --member <id> --email <e>
                 → prints enroll_url
               [ user opens enroll_url in browser → authenticates → webhook → PM becomes ACTIVE ]
               payment-methods get <pm_id>  (or unionpay-status <pm_id>)

[token-cli]    payment-tokens create --type network-token --payment-method-id <pm_id> \
                 --unionpay-amount 174.58 --recipient-first-name ... --recipient-last-name ...
                 → prints checkout_url
               [ user opens checkout_url → authenticates → webhook delivers cryptogram → token ACTIVE ]
               payment-tokens get <ptk_id>

[payment-cli]  payments capture --payment-token-id <ptk_id> --idempotency-key <k>

[merchant-cli] hotel-redaug create-order --payment-token-id <ptk_id> ...
               (or flight-flink create-order / change-pay with --payment-token-id)
```

**Amount units**: `--unionpay-amount` is a decimal string (`"174.58"`); `payments capture` returns integer `amount_cents` (17458). Merchant amounts are also decimal strings.

### Flight Change + Refund

```
change-search → change-apply → change-detail → change-pay → get-order
refund-apply → refund-detail → refund-confirm
```

`change-pay` is required to complete a rebooking — without it the change stays unpaid.

## Behavior Rules (all CLIs)

1. **Ask before assuming**: For any required parameter the user has not provided, you MUST ask before executing. Never use placeholder or hardcoded values.
2. **Session memory**: Remember outputs from previous steps (email, developer_id, api_key, pm_id, ptk_id, order_id, etc.) and reuse them. Do not ask for information already provided.
3. **One step at a time**: Execute one command, confirm the result, then proceed.
4. **Error recovery**: If a command fails, explain the error and suggest a fix. Do not silently retry with different parameters.
5. **Automation mode**: Always add `--yes` when executing for the user (skips TTY prompts only). `--yes` does NOT replace showing the user what will happen and getting their decision before money-moving commands.
6. **Confirm before charging**: Before any `book`, `create-order`, `pay-order`, `change-pay`, or `payments capture`, show the user what will be charged (amount, currency, billing path) and get explicit confirmation.

## Prerequisites

- Node.js 22+
- Install:
  ```bash
  npm install -g @agenzo/admin-cli @agenzo/token-cli @agenzo/payment-cli @agenzo/merchant-cli
  ```
- Default API host: `https://agent.agenzo.com` (change with `agenzo-admin-cli config set-host`).

## Authentication Model

| Plane | CLI | Groups | Auth |
|---|---|---|---|
| Control | `agenzo-admin-cli` | auth, orgs, developers, keys, accounts, config | Bearer Token (`auth login`) |
| Runtime | `agenzo-token-cli` | payment-methods, payment-tokens | API Key (`--api-key`) |
| Runtime | `agenzo-merchant-cli` | ride-elife, hotel-redaug, flight-flink, orders, services | API Key (`--api-key`) |
| Runtime | `agenzo-payment-cli` | payments | API Key (`--api-key`) |

## Shared Conventions

- **API key format**: `sk_<env>_...` — the prefix depends on the environment. `--api-key` takes the full key string.
- **API key scope**: set at `keys create --scope <token,merchant,payment>`. Resources created with one key are NOT visible to another.
- **Idempotency-Key**: write commands take `--idempotency-key`. Never auto-generated — the caller MUST supply a unique value per logical request. Sent as the HTTP header, not in the body. Reuse for retries; fresh value for new requests.
- **`--verbose`**: detailed logs to stderr, includes `request_id` for support.
- **Exit codes**: `0` success · `1` business error · `2` CLI version too old · `3` auth failure · `4` upstream/5xx · `5` user cancel.
- **Non-blocking verbs** (token-cli): `dropin-create`/`dropin-status`, `unionpay-enroll`/`unionpay-status`, `unionpay-create` — return URL/session synchronously without polling. Use when your process manages its own poll loop.

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| Auth failure (exit 3) | Session expired or wrong/unscoped key | Re-login or check key scope |
| Version below minimum (exit 2) | Platform requires newer CLI | `npm install -g @agenzo/<cli>@latest` |
| Connection error (exit 4) | Wrong host or network issue | Check `config show`; verify connectivity |
| 1913 No active payment method | `pay_per_call` account with no ACTIVE payment method | Add one first via `payment-methods add`, then poll until ACTIVE |

Per-CLI errors: [admin-cli](doc/admin-cli.md) · [token-cli](doc/token-cli.md) · [merchant-cli](doc/merchant-cli.md) · [payment-cli](doc/payment-cli.md).

# @agenzo/merchant-cli

[![npm](https://img.shields.io/npm/v/@agenzo/merchant-cli.svg)](https://www.npmjs.com/package/@agenzo/merchant-cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

> **Merchant-fulfillment CLI** for the Agenzo platform — binary `agenzo-merchant-cli`.
> Agents fulfill commerce services here. Each capability is a noun and the set grows over time — use `services` to discover what's available; today's capabilities are ride-hailing (`ride-elife`) and hotel booking (`hotel-redaug`).

**[Overview](#overview)** · **[Features](#features)** · **[Quick Start](#quick-start)** · **[Global flags](#global-flags)** · **[Errors](#output-and-error-contract)** · **[Idempotency-Key](#idempotency-key)**

---

## Overview

`agenzo-merchant-cli` is the command-line entry point for Agents to fulfill commerce services on the Agenzo platform. Each fulfillment capability is exposed as a **noun**, and the set grows over time:

- **`services`** (capability discovery): list what's currently available and how to call it — run this first to learn the current capability set.
- **`ride-elife`** (ride-hailing): the full loop of quote → book → query/poll → cancel → list-orders.
- **`hotel-redaug`** (hotel booking): search, find-destination, hotel-filters, list-cities, hotel-detail, quote, create-order (locks the room AND settles payment inline), get (status/poll), cancel, checkout, get-checkout, list-orders. Supports both **monthly_settlement** (settlement-account deduction) and **pay_per_call** (the platform's own server-side EVO integration; optionally target a specific bound card via `--payment-method-id`) — the funds path is decided server-side by `billing_mode`, the CLI call is identical either way.

More fulfillment capabilities are added as new nouns over time; `services list` always reflects the current set.

## Features

| Noun | Verb | Type | HTTP | Description |
|---|---|---|---|---|
| `services` | `list` | Read | — (local) | List available merchant-fulfillment capabilities |
| `services` | `get <service-id>` | Read | — (local) | Service-layer view: `selection_hints` / `schema_ref` / `conventions` / `workflow` / `verbs_summary` (miss → `SERVICE_NOT_FOUND`); full per-verb flags/response schema is fetched separately via `schema_ref` |
| `ride-elife` | `quote` | Read | `POST /ride/quote` | Point-to-point quote (`vehicle_classes[]` + meet-and-greet) |
| `ride-elife` | `book` | Write/Y | `POST /ride/book` | Book against a quote (monthly_settlement-aware, see below) |
| `ride-elife` | `get` | Read | `GET /ride/<id>/status` | Query order status; `--watch` emits an NDJSON polling stream |
| `ride-elife` | `cancel` | Write/Y | `POST /ride/<id>/cancel` | Cancel an order (no body, may incur a fee) |
| `ride-elife` | `list-orders` | Read | `GET /ride/orders` | List booked trips (pagination + filtering) |
| `hotel-redaug` | `search` | Read | `POST /hotel/search` | Search hotels by coordinates or destination-id + stay dates + filters |
| `hotel-redaug` | `find-destination` | Read | `POST /hotel/find-destination` | Resolve free-text to destinations (destination_id + coordinates) |
| `hotel-redaug` | `hotel-filters` | Read | `POST /hotel/filters` | Get available filter options for a location (codes → search flags) |
| `hotel-redaug` | `list-cities` | Read | `POST /hotel/cities` | List cities for a country (destination_id + coordinates) |
| `hotel-redaug` | `hotel-detail` | Read | `POST /hotel/detail` | Hotel detail with facilities/images AND `rooms[]` (area/floor/beds/photos) — call before quote |
| `hotel-redaug` | `quote` | Read | `POST /hotel/quote` | Real-time rooms/rates for one hotel (`product_token` + `price_items`) |
| `hotel-redaug` | `create-order` | Write/Y | `POST /hotel/create-order` | Create AND pay for a hotel order (locks the rate + settles payment inline; billing path chosen server-side by `billing_mode`); returns `order_id`, already `PAID` |
| `hotel-redaug` | `pay-order` | Write/Y | `POST /hotel/{order_id}/pay` | Trigger supplier confirmation (upstream payOrder) for a paid order; takes only `--order-id` — no payment params needed |
| `hotel-redaug` | `get` | Read | `GET /hotel/<id>/status` | Query order status; `--watch` emits an NDJSON polling stream |
| `hotel-redaug` | `cancel` | Write/Y | `POST /hotel/<id>/cancel` | Cancel a whole order (acceptance ≠ proof; poll `get`) |
| `hotel-redaug` | `checkout` | Write/Y | `POST /hotel/<id>/checkout` | Partial check-out / out-of-policy cancellation (async) |
| `hotel-redaug` | `get-checkout` | Read | `GET /hotel/checkout/<task_order_code>` | Poll a check-out application; `--watch` emits an NDJSON stream |
| `hotel-redaug` | `list-orders` | Read | `GET /hotel/orders` | List hotel orders (pagination + status filter) |

> Write commands (`ride-elife book` / `cancel`; `hotel-redaug create-order` / `pay-order` / `cancel` / `checkout`) are subject to the idempotency-key rules (see [Idempotency-Key](#idempotency-key)).
> Read status verbs `get` / `get-checkout` support `--watch` for NDJSON status polling.
> `ride-elife track` is not available — use `get --watch` for order-status polling.

## Quick Start

### Requirements

- Node.js 22+

### Installation

```bash
npm install -g @agenzo/merchant-cli
agenzo-merchant-cli --version
```

Upgrade later with `npm install -g @agenzo/merchant-cli@latest`.

### Authentication

A runtime-plane CLI that uses an **API Key** (`--api-key`, carried per command as the `X-Api-Key` header):

- The API Key is issued by `agenzo-admin-cli keys create --scope merchant` and must include the `merchant` scope.
- When `--api-key` is omitted, it is requested interactively (password input).
- No Bearer Token or local keystore — every command carries the API Key.

### Ride-hailing end-to-end example

```bash
# 1. Discover capabilities
agenzo-merchant-cli services list
agenzo-merchant-cli services get ride-elife                     # service-layer view: workflow + conventions + verbs_summary
agenzo-merchant-cli ride-elife book --help --format json        # capability layer: this verb's full flags/response schema

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

### Hotel booking end-to-end example

The core Agent loop is `search → quote → create-order → get`. `create-order` is a single write step
that BOTH locks the room AND settles payment inline — there is no separate settlement call. Amounts
are decimal currency units (e.g. `320.00` = 320.00 yuan). The billing path is chosen server-side by
the developer's `billing_mode`, but the CLI call is identical either way:
- **monthly_settlement**: `total_amount` is deducted from the developer's settlement-account balance inline.
- **pay_per_call**: `total_amount` is authorized + captured on the developer's bound card via the platform's own server-side EVO integration — no EVO parameters are ever passed through this CLI. Optionally pass `--payment-method-id` to charge a specific bound card instead of the auto-selected one.

```bash
# 1. Search hotels by coordinates + stay dates (or use --destination-id from find-destination).
#    Pick a hotels[].hotel_id from the result for the quote step.
agenzo-merchant-cli hotel-redaug search --api-key "$API_KEY" \
  --lat 31.2304 --lng 121.4737 --distance 20 \
  --check-in 2026-02-10 --check-out 2026-02-12 \
  --adults 2 --children 0 --room-num 1

# 2. Quote one hotel (produces rates[].product_token, total_price, price_items)
agenzo-merchant-cli hotel-redaug quote --api-key "$API_KEY" \
  --hotel-id "$HOTEL_ID" \
  --check-in 2026-02-10 --check-out 2026-02-12 \
  --adults 2 --room-num 1 --nationality CN

# 3. Create Order (write op: locks rate, no charge; returns order_id + payable amount).
agenzo-merchant-cli hotel-redaug create-order --api-key "$API_KEY" --yes \
  --product-token "$PRODUCT_TOKEN" \
  --total-amount 640.00 --currency CNY \
  --price-items '[{"sale_date":"2026-02-10","sale_price":320.00,"breakfast_num":2},{"sale_date":"2026-02-11","sale_price":320.00,"breakfast_num":2}]' \
  --check-in 2026-02-10 --check-out 2026-02-12 \
  --guest-name "Zhang San" --contact-name "Zhang San" \
  --contact-phone "13800138000" --contact-country-code 86 \
  --idempotency-key "hotel-create-$(date +%s)"

# 4a. Pay Order — monthly_settlement path (on-account)
agenzo-merchant-cli hotel-redaug pay-order --api-key "$API_KEY" --yes \
  --order-id "$ORDER_ID" \
  --idempotency-key "hotel-pay-$(date +%s)"

# 4b. Pay Order — pay_per_call path (user already paid via EVO using order_id
#     as the EVO merchantTransID). Same command, no other flag.
agenzo-merchant-cli hotel-redaug pay-order --api-key "$API_KEY" --yes \
  --order-id "$ORDER_ID" \
  --idempotency-key "hotel-pay-$(date +%s)"

# 4c. Pay Order — pay_per_call with --watch (polls until PAID or timeout)
agenzo-merchant-cli hotel-redaug pay-order --api-key "$API_KEY" --yes \
  --order-id "$ORDER_ID" \
  --idempotency-key "hotel-pay-$(date +%s)" \
  --watch --watch-interval 5 --watch-timeout 120

# 5. Query / poll status. create-order returns order_status=AWAITING_PAYMENT;
#    after pay-order succeeds, status becomes PAID; poll get until CONFIRMED.
agenzo-merchant-cli hotel-redaug get --api-key "$API_KEY" --order-id "$ORDER_ID"
agenzo-merchant-cli hotel-redaug get --api-key "$API_KEY" --order-id "$ORDER_ID" \
  --watch --watch-interval 5 --watch-timeout 600

# 6. List orders (pagination + optional status filter)
agenzo-merchant-cli hotel-redaug list-orders --api-key "$API_KEY" \
  --status CONFIRMED --page 1 --page-size 20

# 7. Cancel a whole order (write op). Acceptance is NOT proof — poll get until CANCELLED.
agenzo-merchant-cli hotel-redaug cancel --api-key "$API_KEY" --yes \
  --order-id "$ORDER_ID" --fc-order-code "$FC_ORDER_CODE" \
  --reason "Change of plans" \
  --idempotency-key "hotel-cancel-$(date +%s)"

# 8. Partial check-out / out-of-policy cancellation (write op, async).
#    Returns task_order_code; poll get-checkout for the refund outcome.
agenzo-merchant-cli hotel-redaug checkout --api-key "$API_KEY" --yes \
  --order-id "$ORDER_ID" --fc-order-code "$FC_ORDER_CODE" \
  --reason "Guest departing early" \
  --checkout-rooms '[{"room_index":"1","guest_name":"Zhang San","cancel_check_in_date":"2026-02-11"}]' \
  --refund-type 1 \
  --idempotency-key "hotel-checkout-$(date +%s)"

# 9. Poll the check-out application until a terminal refund status
agenzo-merchant-cli hotel-redaug get-checkout --api-key "$API_KEY" \
  --task-order-code "$TASK_ORDER_CODE"
agenzo-merchant-cli hotel-redaug get-checkout --api-key "$API_KEY" \
  --task-order-code "$TASK_ORDER_CODE" --watch --watch-interval 10 --watch-timeout 600
```

## Global flags

| Flag | Default | Description |
|---|---|---|
| `--format <json\|table>` | **`json`** | Output format. Defaults to `json`; pass `table` for tabular output. Also reads the `AGENZO_FORMAT` environment variable |
| `--api-key <key>` | — (requested interactively) | API Key, carried per command as the `X-Api-Key` header |
| `--yes` | `false` | Skip interactive confirmation (non-interactive automation); for write commands, `--yes` with a missing idempotency key is a hard error |
| `--verbose` | `false` | Verbose logging (written to stderr) |

## Output and error contract

- **`--format json` (non-watch commands)**: stdout contains only a **single valid JSON** (business payload + `profile`/`endpoint` envelope, where endpoint is host-only without a path); all status/progress/spinner lines go to stderr and are silenced in json mode.
- **`--format table`**: business output goes to stdout, status lines/spinner go to stderr.
- **`get --watch`**: stdout is a line-by-line NDJSON stream, **not wrapped** in the profile/endpoint envelope; polling stops when it hits the terminal-status set (`At destination` / `Cancelled` / `Rejected` / `Customer no show` / `Driver no show`, case-sensitive) or times out; on timeout the final line is `{ "watch_status": "timeout", ... }`.
- **`hotel-redaug get --watch` / `hotel-redaug get-checkout --watch`**: same NDJSON line-stream contract (no envelope). `get` stops when `order_status_code ∈ {3, 4, 5}` (equivalently `order_status ∈ {CONFIRMED, CANCELLED, COMPLETED}`); `get-checkout` stops when `refund_status ∈ {approved, rejected, refunded}`; on timeout the final line is `{ "watch_status": "timeout", ... }`.
- **Error envelope**: `json` → `{ "error": { "code", "code_num", "message", "request_id"? } }`; `table` → `✗ [<code_num>] <message>`. When a request fails, retry with the same `--idempotency-key`; if it persists, contact support with the `request_id` from the error output.

Exit codes:

| Exit code | Meaning | Representative error codes |
|---|---|---|
| `0` | Success | — |
| `1` | Business / param | `PARAM_INVALID`(2101) · `PARAM_IDEMPOTENCY_KEY_REQUIRED`(2102) · `SERVICE_NOT_FOUND`(4101) · `VEHICLE_UNAVAILABLE`(4201) · `QUOTE_EXPIRED`(4202) · `BOOKING_FAILED`(4203) · `CANCELLATION_NOT_ALLOWED`(4204) · `NO_AVAILABILITY`(4301) · `PRICE_CHANGED`(4302) · `NAME_FORMAT_INVALID`(4303) · `HOTEL_ORDER_NOT_FOUND`(4304) · `ALREADY_CANCELLED`(4305) · `CHECKOUT_NOT_ALLOWED`(4306) · `CHECKOUT_TASK_NOT_FOUND`(4307) · `PAY_PER_CALL_NOT_AVAILABLE`(4308) · `BILLING_MODE_MISMATCH`(3001) · `ACCOUNT_*`(31xx) · `PAYMENT_ORDER_*`(32xx) |
| `2` | Upgrade required | `UPGRADE_REQUIRED`(9008) |
| `3` | Auth / invalid key | `KEY_INVALID`(1101) · `KEY_SCOPE_DENIED`(1102) |
| `4` | Network / 5xx | `RATE_LIMITED`(5001) · `UPSTREAM_ERROR`(5101) · `INTERNAL_ERROR`(5201) |
| `5` | User cancel | `CLIENT_ABORTED`(9007) · SIGINT |

> api-key auth mapping: HTTP 401 → `KEY_INVALID`, 403 → `KEY_SCOPE_DENIED`. A known string error code (e.g. `QUOTE_EXPIRED`) takes priority and is preserved; otherwise it falls back to the HTTP-status mapping.

## Idempotency-Key

The write commands `ride-elife book` / `cancel` and `hotel-redaug create-order` / `pay-order` / `cancel` / `checkout` accept `--idempotency-key`:

- Format: `[A-Za-z0-9_-]{1,128}`.
- **The CLI never auto-generates one**: `--yes` with a missing key → hard error `PARAM_IDEMPOTENCY_KEY_REQUIRED` (exit 1), and no request is sent; a missing key without `--yes` → requested interactively.
- Sent as the `Idempotency-Key` HTTP **header**, **never in the body**.
- Reuse the same key to retry the same logical request; use a new key for a new request.

## Billing model for book (monthly_settlement-aware)

`ride-elife book` **does not accept** `--payment-method-id` or any card information — the merchant domain holds no payment handle. Funding is decided according to the Developer's `billing_mode`:

- **monthly_settlement**: deducted from the monthly-settlement account, no payment handle; the response has `payment_status=ON_ACCOUNT` and includes `billing_entry_id`.
- **pay_per_call**: optionally pass through `--payment-order-id` (a PAID order number charged separately, out-of-band); the response echoes `payment_order_id`.

The request body contains at most an optional `payment_order_id`.

### hotel-redaug billing (create-order + pay-order, two billing modes)

`hotel-redaug` uses a **two-step flow**: `create-order` (locks rate, no charge) then `pay-order` (settles).

`pay-order` takes only `--order-id`; there is no merchant-transaction-id flag. The billing path is
chosen server-side by the developer's `billing_mode`:

- **monthly_settlement**: deducted from the monthly-settlement account. The response carries `payment_status=ON_ACCOUNT`.
- **pay_per_call**: the user pays via shared EVO parameters out-of-band using the create-order `order_id` as the EVO merchantTransID; the platform queries EVO for that same `order_id` to confirm payment before calling upstream `payOrder` (response `settlement_path` is `pay_per_call`). If EVO reports "not yet paid", the CLI receives `PAYMENT_NOT_COMPLETED` (exit 1) — use `--watch` to poll until confirmed.

If the order's `billing_mode` is neither of the two values above, `pay-order` returns `BILLING_MODE_MISMATCH` (exit 1).

## Amount units (decimal currency)

Both `ride-elife` and `hotel-redaug` express **every monetary amount in DECIMAL currency units** paired with an ISO 4217 `currency` code — `320.00` means 320.00 yuan, never `32000` minor units (cents/fen). This applies to inputs (`hotel-redaug create-order --total-amount`, each `--price-items[].sale_price`) and to every rendered amount (`quote` totals and `price_items`, `get` / `list-orders` prices, cancellation fees, and refunds). Amounts are forwarded and rendered **verbatim**, with no minor-unit conversion in either direction. This differs from `agenzo-token-cli` and `agenzo-payment-cli`, which use minor units.

## profile / host model

merchant-cli **has no host / config commands** and does not govern environments. It reuses the environment configured by `agenzo-admin-cli` (persisted under `~/.agenzo-admin-cli/`):

- Determines the API host that requests are sent to.
- Provides the environment name + host for the `profile` / `endpoint` envelope in json output.

**Setting the host / switching environments belongs to `agenzo-admin-cli`** (`agenzo-admin-cli config set-host`).

## Machine-readable verb schema

Every `ride-elife` and `hotel-redaug` verb supports `--help --format json`, emitting that verb's machine-readable schema (`cli` / `noun` / `verb` / `description` / `flags` / `response` / `example`, some with `error_recovery` / `polling`):

```bash
agenzo-merchant-cli ride-elife quote --help --format json
agenzo-merchant-cli ride-elife book --help --format json
agenzo-merchant-cli hotel-redaug quote --help --format json
agenzo-merchant-cli hotel-redaug create-order --help --format json   # write verb: error_recovery
agenzo-merchant-cli hotel-redaug pay-order --help --format json      # write verb: error_recovery
agenzo-merchant-cli hotel-redaug get --help --format json             # long-running: polling block
```

For `hotel-redaug`, `create-order` / `pay-order` / `cancel` / `checkout` are the write verbs that require `--idempotency-key`, and `get` / `get-checkout` are the long-running reads that support `--watch` NDJSON streaming (their schemas carry a `polling` block).

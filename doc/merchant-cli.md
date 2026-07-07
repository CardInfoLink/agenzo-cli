# merchant-cli — Merchant Fulfillment (`agenzo-merchant-cli`)

`@agenzo/merchant-cli` — the merchant-fulfillment CLI: Agents use it to fulfill real-world commerce services on the Agenzo platform. Each fulfillment capability is exposed as a **noun**, and the set of capabilities grows over time — run `services list` to discover what is currently available. The capabilities available today are ride-hailing (`ride-elife`) and hotel booking (`hotel-redaug`). **API Key** auth (`--api-key`; the key must have `merchant` scope — see [admin-cli](admin-cli.md) `keys create --scope`).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, idempotency).

## Command matrix

API-Key auth (`--api-key`). `services` discovers the available capabilities; the other nouns are the capabilities themselves (today: `ride-elife`).

| Noun | Verb | Type | Description |
|---|---|---|---|
| `services` | `list` | Read | List the available merchant-fulfillment capabilities |
| `services` | `get <service-id>` | Read | Show a capability's metadata — which noun/verb to call, and the call flow |
| `ride-elife` | `quote` | Read | Request fare quotes between two points; returns vehicle classes, each with its own `quote_id`. |
| `ride-elife` | `book` | Write | Book a ride using a `quote_id` from `quote`; returns a `ride_id` (+ `order_id`). |
| `ride-elife` | `get` | Read | Retrieve a ride order status by id (`--order-id` = the **ride_id**); `--watch` streams status as NDJSON. |
| `ride-elife` | `cancel` | Write | Cancel a ride order (`--order-id` = the **ride_id**); may incur a cancellation fee. |
| `ride-elife` | `list-orders` | Read | List previously placed ride orders. |
| `hotel-redaug` | `create-order` | Write | Create a hotel order without charging (lock inventory). Returns `order_id`. |
| `hotel-redaug` | `pay-order` | Write | Settle an existing hotel order (depends on `create-order`'s `order_id`). |
| `hotel-redaug` | `quote` | Read | Real-time pricing for a hotel + room + dates. |
| `hotel-redaug` | `get` | Read | Retrieve hotel order status; `--watch` streams as NDJSON. |
| `hotel-redaug` | `cancel` | Write | Cancel a hotel order (policy-permitting). |
| `hotel-redaug` | `search` | Read | Search hotels by destination / coordinates. |

> New fulfillment capabilities are added as new nouns over time — run `services list` to see the current set.
> For `ride-elife`, `get` / `cancel` take `--order-id` = the `ride_id` returned by `book`, NOT the `rio_...` order_id. This is a common mistake.

## services

Discover the available merchant-fulfillment capabilities before calling them:

```bash
agenzo-merchant-cli services list                # list available capabilities
agenzo-merchant-cli services get ride-elife      # one capability's metadata (its nouns/verbs + flow)
```

An unknown capability id returns `SERVICE_NOT_FOUND`. As more capabilities are added, they appear here — `services` is how an Agent learns what it can fulfill today.

## ride-elife

Ride-hailing — the fulfillment capability available today.

```bash
# Get fare quotes (returns vehicle classes, each with a quote_id)
agenzo-merchant-cli ride-elife quote --api-key <key> --pickup-lat 1.2816 --pickup-lng 103.8636 --pickup-name "Marina Bay" --dropoff-lat 1.3644 --dropoff-lng 103.9915 --dropoff-name "Changi Airport" --pickup-time now --passenger-name "Jane Doe" --passenger-phone "+6580000000" --passenger-count 1

# Book using a quote_id from `quote`
agenzo-merchant-cli --yes ride-elife book --api-key <key> --quote-id <id> --vehicle-class "Comfort Sedan" --price-amount 14.92 --price-currency USD --passenger-name "Jane Doe" --passenger-phone "+6580000000" --pickup-lat 1.2816 --pickup-lng 103.8636 --pickup-name "Marina Bay" --dropoff-lat 1.3644 --dropoff-lng 103.9915 --dropoff-name "Changi Airport" --pickup-time now --idempotency-key idem_ride_001

# Get / cancel by id — --order-id takes the ride_id returned by book (NOT the rio_... order_id)
agenzo-merchant-cli ride-elife get --api-key <key> --order-id <ride_id>
agenzo-merchant-cli ride-elife get --api-key <key> --order-id <ride_id> --watch --watch-interval 5 --watch-timeout 600   # NDJSON status stream
agenzo-merchant-cli --yes ride-elife cancel --api-key <key> --order-id <ride_id> --idempotency-key idem_cancel_001

# List previously placed orders
agenzo-merchant-cli ride-elife list-orders --api-key <key>
```

### Parameters to ask for (if not provided)

| Parameter | Ask rule |
|-----------|----------|
| `--api-key` | Reuse the `merchant`-scoped key from admin-cli (do not ask again if already known). |
| pickup / dropoff (`--pickup-lat` / `--pickup-lng` / `--pickup-name`, `--dropoff-*`) | MUST ask for `quote` — the two endpoints of the trip. |
| `--pickup-time` | MUST ask (`now` or a future time). |
| `--passenger-name` / `--passenger-phone` | MUST ask for `quote` / `book`. |
| `--quote-id` | For `book`: use a `quote_id` returned by `quote` (do not ask; use the vehicle class the user chose). |
| `--vehicle-class` / `--price-amount` / `--price-currency` | For `book`: take from the chosen quote line. |
| `--order-id` | For `get` / `cancel`: the **ride_id** from `book` (NOT the `rio_...` order_id). |
| `--idempotency-key` | MUST be supplied by the caller for `book` / `cancel`; the CLI never auto-generates one. Prompts interactively if omitted (required under `--yes`). |

## Billing modes — ride-elife (how a ride booking is paid)

A ride booking is paid according to the developer's `billing_mode` (set at [admin-cli](admin-cli.md) `developers create --billing-mode`):

- **`monthly_settlement`**: the fare is deducted from the developer's settlement account balance. `book` returns `payment_status: ON_ACCOUNT` and a `billing_entry_id`; do NOT pass `--payment-order-id`. The settlement account must be funded — check `agenzo-admin-cli accounts get --developer-id <dev>`. A `cancel` refunds the fare back to the balance.
- **`pay_per_call`**: each booking references a separately-paid payment order via `--payment-order-id`.

## Other notable flags (ride-elife book)

Beyond the core ride fields, `book` also accepts: `--passenger-email`, `--luggage-count`, `--special-requests`, `--meet-and-greet` / `--meet-and-greet-price` / `--welcome-sign`, `--child-seat-count` / `--infant-seat-count` / `--toddler-seat-count`, and arrival/departure flight info (`--arrival-flight-no`, `--arrival-airline`, `--departure-flight-no`, `--departure-airline`). Run `agenzo-merchant-cli ride-elife book --help` for the full list.

### Seat pricing

When requesting child/infant/toddler seats, the `--price-amount` must include the seat addon costs:

```
total = base_vehicle_price
      + infant_seat_count  × add_service_unit_price.infant.amount
      + toddler_seat_count × add_service_unit_price.toddler.amount
      + child_seat_count   × add_service_unit_price.children.amount
      + meet_and_greet_price (if applicable)
```

The `add_service_unit_price` object is returned in the `quote` response. If it's absent (null), seats have no additional cost.

### Passenger counts (quote)

`quote` accepts `--children-count`, `--infant-count`, and `--toddler-count` to inform eLife about the passenger breakdown. These affect the `add_service_unit_price` returned and may influence vehicle recommendations.

## hotel-redaug

Hotel booking — full flow: `search` → `hotel-detail` → `quote` → `create-order` → `pay-order` → `get` (poll). The booking (create+pay) portion is split into two independent, ordered steps:

```
hotel-detail → quote → create-order → pay-order → get (poll until CONFIRMED)
```

`hotel-detail` returns the hotel plus `rooms[]` (per-room-type area/floor/beds/photos) — call it for the chosen/shortlisted hotel BEFORE `quote`. `quote`'s `rates[].room_name` is only a bare one-line label with no room detail; pair it with `hotel-detail`'s `rooms[]` (match by `room_name`) so the user picks a rate with real room info in front of them, not just a name and a price.

`create-order` locks inventory and returns an `order_id`. `pay-order` settles the order and requires that `order_id`. There is no combined "book" verb.

### create-order

Creates a hotel order without charging any account. Calls upstream `checkBooking` + `createOrder` and returns the platform `order_id`. The order enters `AWAITING_PAYMENT` status.

```bash
agenzo-merchant-cli --yes hotel-redaug create-order \
  --api-key <key> \
  --product-token <token_from_quote> \
  --total-amount 320.00 \
  --currency CNY \
  --price-items '[{"saleDate":"2026-07-04","salePrice":320.00,"breakfastNum":0}]' \
  --check-in 2026-07-04 \
  --check-out 2026-07-05 \
  --adults 2 --children 0 --nationality CN \
  --guest-name "Zhang San" \
  --contact-name "Zhang San" --contact-phone "13800000000" --contact-country-code 86 \
  --idempotency-key idem_hotel_create_001
```

On success (exit 0), stdout prints:

```
Order ID       ord_abc123
FC Order Code  FC1750000000
Total amount   320.00 CNY
Order status   AWAITING_PAYMENT
```

**Before calling `pay-order`, branch on your `billing_mode`:**

- **`monthly_settlement`**: go straight to `pay-order --order-id <order_id>` — nothing else to do.
- **`pay_per_call`**: do NOT call `pay-order` yet. First drive your own EVO payment integration
  using this `order_id` as the EVO merchantTransID, and get the end-user to actually pay
  `total_amount`+`currency` via EVO. Only once that payment is complete should you call
  `pay-order --order-id <order_id>` — it verifies the EVO payment and settles the order; it
  does not itself collect the payment.

### pay-order

Settles an existing order created by `create-order`. Requires `--order-id` (the `order_id` returned by `create-order`).

pay-order takes only `--order-id`; there is no merchant-transaction-id flag. The billing path is
determined server-side by the developer's `billing_mode`:

| billing_mode | Behavior |
|------|----------|
| `monthly_settlement` | Debits settlement account balance → calls upstream `payOrder`. |
| `pay_per_call` | Platform queries EVO for the **order_id** (the merchantTransID the user paid under) → verifies exact amount/currency → calls upstream `payOrder` (response `settlement_path` is `"pay_per_call"`). |

```bash
# monthly_settlement — debits the settlement account
agenzo-merchant-cli --yes hotel-redaug pay-order \
  --api-key <key> \
  --order-id hho_abc123 \
  --idempotency-key idem_hotel_pay_001

# pay_per_call — user already paid via EVO USING the order_id as the EVO
# merchantTransID. Same command; the platform verifies by querying EVO for the
# order_id.
agenzo-merchant-cli --yes hotel-redaug pay-order \
  --api-key <key> \
  --order-id hho_abc123 \
  --idempotency-key idem_hotel_pay_001

# pay_per_call with --watch (polls until PAID or timeout)
agenzo-merchant-cli --yes hotel-redaug pay-order \
  --api-key <key> \
  --order-id hho_abc123 \
  --idempotency-key idem_hotel_pay_001 \
  --watch --watch-interval 5 --watch-timeout 300
```

On success (exit 0), prints settlement result (order_status = PAID).

### pay_per_call flow (the EVO merchantTransID IS the order_id)

The end-user pays **out-of-band via EVO**, and the payment is bound to the order by using our `order_id` as the EVO `merchantTransID`:

1. Developer creates a hotel order via `create-order` → receives `order_id`, `total_amount`, `currency`.
2. End-user pays the exact `total_amount` + `currency` through EVO (shared merchant parameters obtained through offline EVO onboarding — NOT returned by `create-order`), **using the `order_id` as the EVO `merchantTransID`**.
3. Developer (or Agent) calls `pay-order --order-id <order_id>` (no other identifier).
4. Platform queries EVO **for that `order_id`** once per call:
   - Payment confirmed + amount/currency match → upstream `payOrder` → order becomes `PAID`.
   - Payment not yet confirmed → `PAYMENT_NOT_COMPLETED` (exit 1). Use `--watch` to retry automatically.
   - Amount/currency mismatch → `PAYMENT_AMOUNT_MISMATCH` (exit 1).
   - Transaction not found → `PAYMENT_NOT_FOUND` (exit 1).

**Why the order_id (anti-fraud):** querying by the platform-owned `order_id` binds the EVO payment to this exact order. A caller cannot present some *other* already-paid EVO transaction of the same amount to settle a booking for free. Because there is no caller-supplied merchant-transaction-id, no foreign transaction can be substituted.

### Parameters to ask for (hotel-redaug)

| Parameter | Ask rule |
|-----------|----------|
| `--api-key` | Reuse the `merchant`-scoped key (do not ask again if already known). |
| `--product-token` | From `quote` response — the chosen rate's `product_token`. |
| `--total-amount` / `--currency` | From `quote` response — the chosen rate's price. |
| `--price-items` | From `quote` — per-night price breakdown JSON array. |
| `--check-in` / `--check-out` | MUST ask if not inferred from context. |
| `--guest-name` | MUST ask (primary guest). |
| `--contact-name` / `--contact-phone` | MUST ask (booking contact). |
| `--order-id` | For `pay-order` / `get` / `cancel`: use `order_id` from `create-order`. For `pay_per_call`, this is ALSO the EVO merchantTransID — tell the user to pay under this exact id. |
| `--idempotency-key` | MUST be supplied for `create-order` / `pay-order` / `cancel`. |

### hotel-redaug billing modes

`pay-order` takes only `--order-id`; there is no merchant-transaction-id flag. The billing path
is chosen server-side by the developer's `billing_mode`:

| Mode | Behavior |
|------|----------|
| `monthly_settlement` | Balance deducted → upstream `payOrder`. |
| `pay_per_call` | Platform queries EVO for the `order_id` → verifies exact amount/currency → upstream `payOrder`. If not yet paid → `PAYMENT_NOT_COMPLETED`. |
| anything else | `BILLING_MODE_MISMATCH` (only the two modes above are valid). |

## Merchant-specific errors

| Error | Cause | Fix |
|-------|-------|-----|
| `KEY_SCOPE_DENIED` | API key does not include `merchant` scope | Create a key with `--scope merchant` (admin-cli `keys create`) |
| `SERVICE_NOT_FOUND` | Unknown capability id passed to `services get` | Run `services list` to see valid ids |
| `QUOTE_EXPIRED` | The `quote_id` is too old | Re-run `quote` and book with a fresh `quote_id` |
| `VEHICLE_UNAVAILABLE` | The chosen vehicle class is no longer available | Re-quote and pick an available class |
| `BOOKING_FAILED` | The provider rejected the booking | Re-quote and retry; verify passenger details |
| `CANCELLATION_NOT_ALLOWED` | The ride is past the cancellable state | The ride can no longer be cancelled |
| `PARAM_IDEMPOTENCY_KEY_REQUIRED` | `--idempotency-key` missing for a write under `--yes` | Supply a unique `--idempotency-key` |
| `INVALID_ORDER_STATE` | Hotel order is not in `AWAITING_PAYMENT` state | Check order status with `get`; only `AWAITING_PAYMENT` orders can be paid |
| `BILLING_MODE_MISMATCH` | Order's `billing_mode` is not `monthly_settlement` or `pay_per_call` | Check the developer's billing_mode; do not retry blindly |
| `PAYMENT_NOT_COMPLETED` | EVO payment not yet confirmed for this `order_id` | Retry later or use `--watch` to poll automatically |
| `PAYMENT_NOT_FOUND` | No EVO transaction found for this `order_id` | Confirm the user paid via EVO using the `order_id` as the merchantTransID |
| `PAYMENT_AMOUNT_MISMATCH` | EVO payment amount/currency does not match the order | User must pay the exact `total_amount` in the exact `currency` under the `order_id` |
| `NO_AVAILABILITY` | Hotel room is no longer available | Re-run `quote` and try a different rate |
| `PRICE_CHANGED` | Price has changed since quote | Re-run `quote` for updated pricing |

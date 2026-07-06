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
| `hotel-redaug` | `create-order` | Write | Create AND pay for a hotel order in one call (billing path decided server-side by `billing_mode`). Returns `order_id`, already `PAID`. |
| `hotel-redaug` | `quote` | Read | Real-time pricing for a hotel + room + dates. |
| `hotel-redaug` | `get` | Read | Retrieve hotel order status; `--watch` streams as NDJSON. |
| `hotel-redaug` | `cancel` | Write | Cancel a hotel order (policy-permitting). |
| `hotel-redaug` | `search` | Read | Search hotels by destination / coordinates. |

> New fulfillment capabilities are added as new nouns over time — run `services list` to see the current set.
> For `ride-elife`, `get` / `cancel` take `--order-id` = the `ride_id` returned by `book`, NOT the `rio_...` order_id. This is a common mistake.

## services

Discover the available merchant-fulfillment capabilities before calling them:

```bash
agenzo-merchant-cli services list                          # list available capabilities
agenzo-merchant-cli services get ride-elife                # service-layer view: workflow + conventions + verbs_summary
agenzo-merchant-cli ride-elife book --help --format json   # capability layer: this verb's full flags/response schema
```

An unknown capability id returns `SERVICE_NOT_FOUND`. As more capabilities are added, they appear here — `services` is how an Agent learns what it can fulfill today.

`services get` returns the **service layer** (doc/architecture-upgrade/v1/schema-standard.md §3): `selection_hints` / `schema_ref` / `conventions` / the full `workflow` object / `verbs_summary` (verb name + one-line description + read/write `annotations`, no parameters). It deliberately does NOT inline each verb's full `flags`/`response`/`example`/`error_recovery` — that capability-layer detail (tens of KB across a dozen verbs) stays behind the two paths named in `schema_ref`: `<noun> <verb> --help --format json` (local, always matches the installed CLI) or `schema_ref.schema_url` (HTTP, aggregate download). Both paths return the same per-verb schema shape.

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

Hotel booking — full flow: `search` → `hotel-detail` → `quote` → `create-order` → `pay-order` → `get` (poll). `create-order` handles all payment logic (authorize+capture from the developer's account/card) AND locks the room with the supplier; `pay-order` then triggers supplier confirmation (upstream payOrder). The two steps are separate because payment settlement and supplier confirmation are distinct operations:

```
hotel-detail → quote → create-order (settles payment + locks room) → pay-order (supplier confirmation) → get (poll until CONFIRMED)
```

`hotel-detail` returns the hotel plus `rooms[]` (per-room-type area/floor/beds/photos) — call it for the chosen/shortlisted hotel BEFORE `quote`. `quote`'s `rates[].room_name` is only a bare one-line label with no room detail; pair it with `hotel-detail`'s `rooms[]` (match by `room_name`) so the user picks a rate with real room info in front of them, not just a name and a price.

`create-order` returns an `order_id` (and a supplier `fc_order_code`) with the order already in `PAID` status (funds settled). `pay-order` takes that `order_id` and triggers the supplier's confirmation step — there is no payment gateway interaction for the caller at this point.

### create-order

Creates AND pays for a hotel order. The backend re-checks availability (`checkBooking`), authorizes/deducts payment via the platform's payment gateway (funds path decided server-side by `billing_mode`), and locks the room with the supplier (`createOrder`). On success, the order is returned already `PAID`. If any step after funds are taken fails (e.g. the room sold out, or the supplier rejected the booking), the funds are automatically released/refunded before the error is returned — a failed `create-order` never leaves money captured.

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
Order ID       hho_abc123
FC Order Code  FC1750000000
Total amount   320.00 CNY
Order status   PAID
```

**Billing mode determines the funds path, but the Agent/caller issues the exact same command either way:**

- **`monthly_settlement`**: the platform deducts `total_amount` from the developer's settlement-account balance inline. Nothing else to do.
- **`pay_per_call`**: the platform authorizes and captures `total_amount` on the developer's already-bound card via its own EVO integration, entirely server-side — no EVO parameters are ever passed through this CLI. Optionally pass `--payment-method-id` to charge a SPECIFIC already-bound card instead of the platform's auto-selected default/most-recent one.

```bash
# pay_per_call — charging a specific bound card instead of the auto-selected one
agenzo-merchant-cli --yes hotel-redaug create-order \
  --api-key <key> \
  --product-token <token_from_quote> \
  --total-amount 500.00 \
  --currency USD \
  --price-items '[{"saleDate":"2026-08-01","salePrice":500.00,"breakfastNum":0}]' \
  --check-in 2026-08-01 --check-out 2026-08-02 \
  --guest-name "John Doe" \
  --contact-name "John Doe" --contact-phone "5551234567" --contact-country-code 1 \
  --payment-method-id pm_01ABCXYZ \
  --idempotency-key idem_hotel_create_002
```

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
| `--payment-method-id` | Optional, `pay_per_call` only. From `agenzo-token-cli payment-methods list` — an ACTIVE card belonging to this developer. Omit to let the platform auto-select. |
| `--order-id` | For `pay-order` / `get` / `cancel`: use `order_id` from `create-order`. |
| `--idempotency-key` | MUST be supplied for `create-order` / `pay-order` / `cancel`. |

### pay-order

Triggers supplier confirmation (upstream `payOrder`) for an order already paid via `create-order`. Takes only `--order-id` — no payment parameters needed because funds were already settled in `create-order`.

```bash
agenzo-merchant-cli --yes hotel-redaug pay-order \
  --api-key <key> \
  --order-id hho_abc123 \
  --idempotency-key idem_hotel_pay_001
```

On success (exit 0), the supplier begins asynchronous confirmation — poll `get --order-id` until CONFIRMED (3).

### hotel-redaug billing modes

The billing path is chosen server-side by the developer's `billing_mode` — `create-order` takes the same flags either way:

| Mode | Behavior |
|------|----------|
| `monthly_settlement` | Balance deducted from the settlement account → order created with the supplier → returned `PAID`. |
| `pay_per_call` | Card authorized + captured via the platform's own EVO integration (optionally a specific card via `--payment-method-id`) → order created with the supplier → returned `PAID`. |
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
| `BILLING_MODE_MISMATCH` | Order's `billing_mode` is not `monthly_settlement` or `pay_per_call` | Check the developer's billing_mode; do not retry blindly |
| `PAYMENT_METHOD_REQUIRED` | `pay_per_call` developer has no ACTIVE bound card, or the passed `--payment-method-id` isn't ACTIVE / doesn't belong to this developer | Bind a card (`agenzo-token-cli payment-methods add`), drop `--payment-method-id` to auto-select, or pass a valid one |
| `ACCOUNT_INSUFFICIENT_BALANCE` | `monthly_settlement` developer's settlement credit is insufficient | Top up the settlement account (offline); do not retry until funded |
| `ACCOUNT_NOT_FOUND` | `monthly_settlement` developer has no settlement account | Complete contract signing |
| `ACCOUNT_SUSPENDED` | The settlement account is suspended | Contact support; do not retry |
| `NO_AVAILABILITY` | Hotel room is no longer available | Re-run `quote` and try a different rate |
| `PRICE_CHANGED` | Price has changed since quote | Re-run `quote` for updated pricing |

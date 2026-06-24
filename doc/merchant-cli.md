# merchant-cli — Merchant Fulfillment (`agenzo-merchant-cli`)

`@agenzo/merchant-cli` — the merchant-fulfillment CLI: Agents use it to fulfill real-world commerce services on the Agenzo platform. Each fulfillment capability is exposed as a **noun**, and the set of capabilities grows over time — run `services list` to discover what is currently available. The capability available today is ride-hailing (`ride-elife`). **API Key** auth (`--api-key`; the key must have `merchant` scope — see [admin-cli](admin-cli.md) `keys create --scope`).

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

## Billing modes (how a booking is paid)

A booking is paid according to the developer's `billing_mode` (set at [admin-cli](admin-cli.md) `developers create --billing-mode`):

- **`monthly_settlement`**: the fare is deducted from the developer's settlement account balance. `book` returns `payment_status: ON_ACCOUNT` and a `billing_entry_id`; do NOT pass `--payment-order-id`. The settlement account must be funded — check `agenzo-admin-cli accounts get --developer-id <dev>`. A `cancel` refunds the fare back to the balance.
- **`pay_per_call`**: each booking references a separately-paid payment order via `--payment-order-id`.

## Other notable flags (book)

Beyond the core ride fields, `book` also accepts: `--passenger-email`, `--luggage-count`, `--special-requests`, `--meet-and-greet` / `--meet-and-greet-price` / `--welcome-sign`, child/infant/toddler seat counts, and arrival/departure flight info (`--arrival-flight-no`, `--arrival-airline`, `--departure-flight-no`, `--departure-airline`). Run `agenzo-merchant-cli ride-elife book --help` for the full list.

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

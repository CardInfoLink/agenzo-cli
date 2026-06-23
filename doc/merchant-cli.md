# merchant-cli — Ride Fulfillment (`agenzo-merchant-cli`)

`@agenzo/merchant-cli` — books rides via the eLife provider. **API Key** auth (`--api-key`; the key must have `merchant` scope — see [admin-cli](admin-cli.md) `keys create --scope`). All commands live under the `ride-elife` noun.

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, idempotency).

## Commands

```bash
# Get fare quotes (returns vehicle classes, each with a quote_id)
agenzo-merchant-cli ride-elife quote --api-key <key> --pickup-lat 1.2816 --pickup-lng 103.8636 --pickup-name "Marina Bay" --dropoff-lat 1.3644 --dropoff-lng 103.9915 --dropoff-name "Changi Airport" --pickup-time now --passenger-name "Jane Doe" --passenger-phone "+6580000000" --passenger-count 1

# Book using a quote_id from `quote`
agenzo-merchant-cli --yes ride-elife book --api-key <key> --quote-id <id> --vehicle-class "Comfort Sedan" --price-amount 14.92 --price-currency USD --passenger-name "Jane Doe" --passenger-phone "+6580000000" --pickup-lat 1.2816 --pickup-lng 103.8636 --pickup-name "Marina Bay" --dropoff-lat 1.3644 --dropoff-lng 103.9915 --dropoff-name "Changi Airport" --pickup-time now --idempotency-key idem_ride_001

# Get / cancel by id — NOTE: --order-id takes the ride_id returned by book (NOT the rio_... order_id)
agenzo-merchant-cli ride-elife get --api-key <key> --order-id <ride_id>
agenzo-merchant-cli --yes ride-elife cancel --api-key <key> --order-id <ride_id> --idempotency-key idem_cancel_001

# List previously placed orders
agenzo-merchant-cli ride-elife list-orders --api-key <key>
```

| Verb | Type | Description |
|---|---|---|
| `quote` | Read | Request fare quotes between two points; returns vehicle classes, each with its own `quote_id`. |
| `book` | Write | Book a ride using a `quote_id` from `quote`; returns a `ride_id` (+ `order_id`). |
| `get` | Read | Retrieve a ride order status by id (`--order-id` = the **ride_id**). |
| `cancel` | Write | Cancel a ride order (`--order-id` = the **ride_id**); may incur a cancellation fee. |
| `list-orders` | Read | List previously placed ride orders. |

> **`get` / `cancel` use `--order-id` = the `ride_id` returned by `book`**, NOT the `rio_...` order_id. This is a common mistake.

## Billing modes (how a booking is paid)

A booking is paid according to the developer's `billing_mode` (set at [admin-cli](admin-cli.md) `developers create --billing-mode`):

- **`monthly_settlement`**: the fare is deducted from the developer's settlement account balance. `book` returns `payment_status: ON_ACCOUNT` and a `billing_entry_id`; do NOT pass `--payment-order-id`. The settlement account must be funded — check `agenzo-admin-cli accounts get --developer-id <dev>`. A `cancel` refunds the fare back to the balance.
- **`pay_per_call`**: each booking references a separately-paid payment order via `--payment-order-id`.

## Other notable flags (book)

Beyond the core ride fields, `book` also accepts: `--passenger-email`, `--luggage-count`, `--special-requests`, `--meet-and-greet` / `--meet-and-greet-price` / `--welcome-sign`, child/infant/toddler seat counts, and arrival/departure flight info (`--arrival-flight-no`, `--arrival-airline`, `--departure-flight-no`, `--departure-airline`). Run `agenzo-merchant-cli ride-elife book --help` for the full list.

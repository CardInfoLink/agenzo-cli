# merchant-cli — Merchant Fulfillment (`agenzo-merchant-cli`)

`@agenzo/merchant-cli` — the merchant-fulfillment CLI: Agents use it to fulfill real-world commerce services on the Agenzo platform. Each capability is exposed as a **noun**, and the set grows over time — run `services list` to discover what is currently available.

**Auth:** API Key per command (`--api-key`, sent as `X-Api-Key`); the key must carry `merchant` scope (see [admin-cli](admin-cli.md) `keys create --scope`). There is no login/session.
**Output:** defaults to `--format json` (agent-first), unlike other binaries which default to `table`.

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, idempotency).

## Registered nouns

| Noun | Verbs | Purpose |
|---|---|---|
| `services` | 2 | Capability discovery (backed by the platform discovery catalog) |
| `orders` | 2 | Unified cross-provider order index (`GET /orders`) |
| `ride-elife` | 5 | Ride ordering (eLife) |
| `hotel-redaug` | 14 | Hotel booking (Redaug) |
| `flight-flink` | 21 | Flight booking (Flink), incl. change + refund |

Every verb listed in this document is registered in `apps/merchant-cli/src/index.ts` and executable today.

## services — capability discovery

```bash
agenzo-merchant-cli services list                     # discover capabilities
agenzo-merchant-cli services get hotel-redaug         # one capability + full schema
```

| Verb | Type | Description |
|---|---|---|
| `list` | Read | List available merchant capabilities (id, name, category, provider, `cli_noun`, verbs) |
| `get <service-id>` | Read | One capability's full metadata, including `schema_content` (per-verb params) and `workflow` |

How it resolves:

- Primary source is the platform discovery API (`GET /api/discovery/v1/catalog`, host root — *not* the `/api/merchant/v1` prefix). `services get` calls `.../catalog/<service-id>`.
- Results are **gated against this binary's own command tree**: a capability whose `cli_noun` is not registered locally is hidden, and its `verbs[]` (plus `schema_content.verbs`) are intersected with the locally-registered verbs. An Agent therefore never sees a service or verb this CLI cannot run.
- If the platform is unreachable, it falls back to the CLI-bundled registry (basic metadata, no `schema_content`), gated the same way.
- Accepted `<service-id>`: either the catalog `service_id` or the `cli_noun` (e.g. both `hotel-redaug` and the flight capability's `svc_...` id resolve). Unknown id → `SERVICE_NOT_FOUND`.
- The catalog covers the three fulfillment capabilities (`ride-elife`, `hotel-redaug`, `flight-flink`). `services` and `orders` are utility nouns and are not catalog entries.

## orders — unified cross-provider order index

Spans ride + hotel (+ future providers) in one call. Use it for generic "my orders" / "order history" requests; switch to the domain noun's `list-orders` / `get` once the business is known (those return domain-specific fields).

| Verb | Type | Key flags | Description |
|---|---|---|---|
| `list` | Read | `--order-type ride\|hotel`, `--status PENDING\|CONFIRMED\|COMPLETED\|CANCELLED\|FAILED`, `--page`, `--page-size` | Cross-provider order list with normalized status |
| `get` | Read | `--order-id` (**required**) | One order's detail by id, regardless of provider |

```bash
agenzo-merchant-cli orders list --api-key <key> --status CONFIRMED --page-size 20
agenzo-merchant-cli orders get  --api-key <key> --order-id hho_abc123
```

- `list` returns a small fixed column set (`order_id` / `order_type` / `status` / `amount` / `currency`) plus `total` / `page` / `page_size`.
- `get` accepts any provider id (`rio_...` ride, `hho_...` hotel); the platform resolves `order_id → order_type` and delegates to the owning domain, so **the response shape varies by `order_type`** — treat it as an opaque object and surface the fields present.

## ride-elife — ride ordering

| Verb | Type | Idempotency-Key | Description |
|---|---|---|---|
| `quote` | Read | — | Fare quotes between two points → `vehicle_classes[]`, each with its own `quote_id` |
| `book` | Write | Required | Book one vehicle class by `quote_id` → `ride_id` (+ `order_id`) |
| `get` | Read | — | Ride status by `--order-id` = the **`ride_id`**; `--watch` streams NDJSON |
| `cancel` | Write | Required | Cancel a ride by `--order-id` = the **`ride_id`**; may incur a fee |
| `list-orders` | Read | — | List the developer's ride orders (`--status`, `--order-type`, `--page`, `--page-size`) |

```bash
# 1. quote
agenzo-merchant-cli ride-elife quote --api-key <key> \
  --pickup-lat 1.2816 --pickup-lng 103.8636 --pickup-name "Marina Bay" \
  --dropoff-lat 1.3644 --dropoff-lng 103.9915 --dropoff-name "Changi Airport" \
  --pickup-time now --passenger-name "Jane Doe" --passenger-phone "+6580000000" --passenger-count 1

# 2. book — repeat the SAME coordinates/names/pickup-time; quote_id does not carry them
agenzo-merchant-cli --yes ride-elife book --api-key <key> --quote-id <id> \
  --vehicle-class Sedan --price-amount 14.92 --price-currency USD \
  --passenger-name "Jane Doe" --passenger-phone "+6580000000" \
  --pickup-lat 1.2816 --pickup-lng 103.8636 --pickup-name "Marina Bay" \
  --dropoff-lat 1.3644 --dropoff-lng 103.9915 --dropoff-name "Changi Airport" \
  --pickup-time now --idempotency-key idem_ride_001

# 3. poll / cancel — --order-id is the ride_id from book, NOT the rio_... order_id
agenzo-merchant-cli ride-elife get --api-key <key> --order-id <ride_id> --watch
agenzo-merchant-cli --yes ride-elife cancel --api-key <key> --order-id <ride_id> --idempotency-key idem_cancel_001
```

Key rules:

- Coordinates are **not** geocoded server-side — always supply `--pickup-lat/lng` and `--dropoff-lat/lng`.
- `vehicle_class` values are case-sensitive literals (`Sedan` / `SUV` / `MPV-5` / `MPV-7` / `Van` / `Luxury` / `Train`) — pass back verbatim.
- `--pickup-time` is UTC epoch seconds or the literal `now`.
- All amounts are **decimal** currency units (42.50 = $42.50), never minor units.
- `book` accepts no card/payment-method flags. Billing is server-side: `pay_per_call` requires a PAID `--payment-order-id` (from payment-cli); `monthly_settlement` forbids it (fare deducted from the settlement balance, response `payment_status: ON_ACCOUNT` + `billing_entry_id`; `cancel` refunds to the balance).
- Extra `book` flags: `--passenger-email`, `--luggage-count`, `--special-requests`, `--meet-and-greet` / `--meet-and-greet-price` / `--welcome-sign`, `--child-seat-count` / `--infant-seat-count` / `--toddler-seat-count`, `--arrival-flight-no` / `--arrival-airline` / `--departure-flight-no` / `--departure-airline`.
- **Seat pricing:** `--price-amount` must include addons — `base + infant×infant + toddler×toddler + child×children unit prices + meet_and_greet_price`. Unit prices come from `quote`'s `add_service_unit_price` (null ⇒ seats are free). `quote`'s `--children-count` / `--infant-count` / `--toddler-count` drive that object.

## hotel-redaug — hotel booking (14 verbs)

| Verb | Type | Key flags | Description |
|---|---|---|---|
| `find-destination` | Read | `--keyword`, `--data-type` | Resolve a place name → coordinates / destination |
| `list-cities` | Read | `--country` | City + `destination_id` dictionary for a country |
| `hotel-filters` | Read | `--destination-id` \| `--lat`+`--lng`, `--distance` | Filter options (star / brand / facility codes) for a location |
| `search` | Read | `--destination-id` \| `--lat`+`--lng`, `--check-in`, `--check-out`, `--adults`, `--room-num`, `--star`, `--price-min/max`, `--*-codes`, `--page` | Search hotels (exactly one location branch) |
| `hotel-detail` | Read | `--hotel-id`, `--with-images` | Hotel + `rooms[]` (area/floor/beds/photos) |
| `quote` | Read | `--hotel-id`, `--check-in`, `--check-out`, `--adults`, `--room-num`, `--nationality` | Real-time rates → `product_token` + `price_items` |
| `create-order` | Write | see below | Lock inventory without charging → `order_id`, status `AWAITING_PAYMENT` |
| `pay-order` | Write | `--order-id`, `--watch` | Settle the order (path chosen server-side by `billing_mode`) |
| `get` | Read | `--order-id`, `--watch` | Order status (poll until `CONFIRMED`) |
| `cancel` | Write | `--order-id`, `--fc-order-code`, `--reason` | Whole-order cancellation, within policy |
| `checkout` | Write | `--order-id`, `--fc-order-code`, `--checkout-rooms`, `--refund-type`, `--reason` | Apply for partial check-out / out-of-policy cancellation (async, property must approve) |
| `get-checkout` | Read | `--task-order-code`, `--watch` | Poll a check-out application's status + refund outcome |
| `list-orders` | Read | `--status`, `--page`, `--page-size` | List the developer's hotel orders |
| `skill` | Read | — | Print the hotel-redaug usage guide (offline, no API call) |

Workflow:

```
find-destination [→ hotel-filters] → search → hotel-detail → quote
  → create-order → pay-order → get (poll until CONFIRMED)
  [→ cancel | checkout → get-checkout]
```

- `hotel-detail` before `quote`: `quote`'s `rates[].room_name` is a bare label with no room detail. Pair each rate with `hotel-detail`'s `rooms[]` (match on `room_name`) so the user picks a rate with real room info in front of them.
- `product_token` is opaque — pass it unchanged to `create-order`; `--price-items` must be copied **verbatim** from `quote` as a JSON array.
- `create-order` locks inventory and charges nothing. There is no combined "book" verb.
- All amounts are decimal units, never cents.

### create-order

```bash
agenzo-merchant-cli --yes hotel-redaug create-order --api-key <key> \
  --product-token <token_from_quote> \
  --total-amount 320.00 --currency CNY \
  --price-items '[{"saleDate":"2026-07-04","salePrice":320.00,"breakfastNum":0}]' \
  --check-in 2026-07-04 --check-out 2026-07-05 \
  --adults 2 --children 0 --nationality CN \
  --guest-name "Zhang San" \
  --contact-name "Zhang San" --contact-phone "13800000000" --contact-country-code 86 \
  --idempotency-key idem_hotel_create_001
```

Optional: `--bed-type` (from the chosen rate's `beds[].code`, forwarded upstream), `--tips` (platform-local, order-detail display only), `--arrive-time`, `--special-requests`, `--hotel-name`, `--contact-email`, plus the payment credential flags below.

Payment credential flags (both optional, omit to let the platform decide by `billing_mode`):

| Flag | Effect |
|---|---|
| `--payment-method-id` | Settle this order on that specific bound card (pay_per_call / EVO preauth + capture) |
| `--payment-token-id` | **UnionPay pre-charged path.** A payment token id from an already-completed UPI network-token capture: the platform skips EVO preauth/capture and only locks the order + records the credential (funds already charged) |

### pay-order

`pay-order` takes only `--order-id` — there is no merchant-transaction-id flag. The billing path is chosen server-side:

| `billing_mode` | Behavior |
|---|---|
| `monthly_settlement` | Debit settlement balance → upstream `payOrder` |
| `pay_per_call` | Platform queries EVO for the **`order_id`** (the merchantTransID the user paid under) → verifies exact amount + currency → upstream `payOrder` (`settlement_path: "pay_per_call"`) |
| anything else | `BILLING_MODE_MISMATCH` |

```bash
agenzo-merchant-cli --yes hotel-redaug pay-order --api-key <key> \
  --order-id hho_abc123 --idempotency-key idem_hotel_pay_001 \
  --watch --watch-interval 5 --watch-timeout 300
```

For `pay_per_call`, drive the EVO payment **before** calling `pay-order`: the end-user pays the exact `total_amount` + `currency` using the platform `order_id` as the EVO `merchantTransID` (EVO merchant parameters come from offline onboarding, not from `create-order`). Then `pay-order` verifies and settles — it never collects the payment itself. Not yet paid → `PAYMENT_NOT_COMPLETED` (use `--watch` to keep polling); mismatch → `PAYMENT_AMOUNT_MISMATCH`; no transaction → `PAYMENT_NOT_FOUND`.

**Why bind on `order_id` (anti-fraud):** querying by the platform-owned `order_id` ties the EVO payment to this exact order, so no caller-supplied identifier can substitute some other already-paid transaction of the same amount.

### Parameters to ask for (hotel-redaug)

| Parameter | Ask rule |
|---|---|
| `--api-key` | Reuse the `merchant`-scoped key; do not re-ask once known |
| `--check-in` / `--check-out` | MUST ask unless inferable from context |
| `--guest-name`, `--contact-name`, `--contact-phone` | MUST ask |
| `--product-token`, `--total-amount`, `--currency`, `--price-items` | Take from the chosen `quote` rate — never invent |
| `--order-id` | From `create-order`; for `pay_per_call` this is also the EVO merchantTransID |
| `--fc-order-code` / `--checkout-rooms` | From the order response (`fc_order_code`, `rooms[]`) — copy verbatim |
| `--idempotency-key` | Caller-supplied for every write (`create-order` / `pay-order` / `cancel` / `checkout`); never auto-generated |

## flight-flink — flight booking (21 verbs)

International flight booking via the Flink provider: two-step create-then-pay ticketing, `journeyId` relay for round-trip / multi-city, plus change (rebooking) and refund flows.

| Verb | Type | Idempotency-Key | Key flags | Description |
|---|---|---|---|---|
| `find-airport` | Read | — | `--keyword` | Resolve a place name → IATA city/airport candidates |
| `list-airports` | Read | — | `--page`, `--page-size`, `--keyword` | Airport dictionary |
| `list-airlines` | Read | — | `--page`, `--page-size`, `--keyword` | Airline dictionary |
| `list-nationalities` | Read | — | — | Nationality list |
| `search` | Read | — | `--trip-type`, `--journeys`, `--cabin-class`, `--adult-num`/`--child-num`/`--infant-num`, `--airline`, `--transfer-number`, `--journey-id` | Flight search (one-way / round-trip / multi-city) |
| `more-offers` | Read | — | `--product-token` | Additional fare offers for a priceKey |
| `verify` | Read | — | `--product-token` | Verify the fare → authoritative `product_token`, `price_changed` |
| `create-order` | Write | Required | `--product-token`, `--total-amount`, `--currency`, `--trip-type`, `--contact-*`, `--passengers`, `--payment-method-id`, `--payment-token-id` | Lock the fare (no charge) → `order_no`, `AWAITING_PAYMENT` |
| `pay-order` | Write | Required | `--order-no` | Settle + trigger ticketing → `PAID` |
| `get-order` | Read | — | `--order-no`, `--watch`, `--watch-interval`, `--watch-timeout` | Order status (poll until `TICKETED`) |
| `cancel-order` | Write | Required | `--order-no`, `--reason` | Cancel an un-ticketed order (+ refund) |
| `list-orders` | Read | — | `--status`, `--page`, `--page-size` | List flight orders (platform-local, no upstream call) |
| `change-search` | Read | — | `--order-no`, `--date`, `--passenger`, `--segment-id`, `--cabin-class` | Search rebook-eligible flights |
| `change-apply` | Write | Required | `--order-no`, `--passenger`, `--segment-id`, `--product-token`, `--contact-*` | Apply a rebooking → `change_order_no` |
| `change-detail` | Read | — | `--change-order-no` | Change request status + `price_total` (the change fee) |
| `change-pay` | Write | Required | `--change-order-no`, `--order-no`, `--amount`, `--currency`, `--payment-method-id`, `--payment-token-id` | Pay the change fee, then trigger change ticketing |
| `change-cancel` | Write | Required | `--change-order-no` | Cancel a pending change request |
| `refund-apply` | Write | Required | `--order-no`, `--passenger`, `--segment-id`, `--reason-type`, `--reason`, `--contact-*` | Apply a refund → `refund_order_no` |
| `refund-detail` | Read | — | `--refund-order-no` | Refund request status |
| `refund-confirm` | Write | Required | `--refund-order-no`, `--confirm` (`1` confirm / `2` cancel) | Confirm or cancel a refund application |
| `skill` | Read | — | — | Print the flight-flink usage guide (offline, no API call) |

Booking workflow:

```
find-airport → search (relay --journey-id per leg until price_key_ready)
  → verify → create-order → pay-order → get-order (poll until TICKETED)
```

Change workflow (`change-pay` is the step most often missed):

```
change-search → change-apply → change-detail → change-pay → get-order
                                            └→ change-cancel (abandon)
```

Refund workflow: `refund-apply → refund-detail → refund-confirm --confirm 1|2`.

Key rules:

- **search**: `--journeys` always carries ALL legs. For round-trip / multi-city, feed `--journey-id` from the previous result to accumulate selections; only the final leg's offer has `price_key_ready: true`.
- **verify**: returns the authoritative `product_token` (may differ from search's) — always pass verify's token to `create-order`. If `price_changed`, re-confirm the new price with the user.
- **create-order**: `--passengers` is a JSON array; `gender` / `id_type` are **strings** (`"1"` / `"2"`); child/infant entries need `adult_passenger_name`. Locks the fare without charging.
- **Ticketing is asynchronous** — never claim "booked" until `get-order` returns `TICKETED`. Single-passenger ~100s, multi-passenger 150s+; use `--watch`.
- **cancel-order** only applies to un-ticketed orders (`AWAITING_PAYMENT` / `PAID`). Once `TICKETED`, use `refund-apply`.
- **change-pay** charges the change fee exactly like a normal order — take `--amount` from `change-detail`'s `price_total`, and pass `--order-no` (the original order) for the ownership check. It then calls upstream change ticketing; poll `get-order`.
- Every write verb requires `--idempotency-key`; reuse the SAME key when retrying the same intent.

### Payment credentials (`create-order`, `change-pay`)

| Flag | Effect |
|---|---|
| *(neither)* | Platform picks the path from the developer's `billing_mode` |
| `--payment-method-id` | Charge that bound card via the platform's EVO integration (pay_per_call) |
| `--payment-token-id` | **UnionPay pre-charged path** — a UPI network-token id whose capture already completed; the platform skips EVO preauth/capture and records the credential against the order/change |

Billing modes otherwise match hotel: `monthly_settlement` deducts from the settlement account on `pay-order`; `pay_per_call` is captured server-side (no EVO parameters pass through the CLI).

### Parameters to ask for (flight-flink)

| Verb | Must ask the user | Derived / defaulted |
|---|---|---|
| `find-airport` | keyword | — |
| `search` | trip-type, journeys (origin/destination/date per leg) | `--journey-id` from the prior search |
| `verify` | — | `product_token` from `search` |
| `create-order` | contact-name, contact-phone, passengers (name/gender/id/birthday) | `total-amount` + `currency` from `verify`; idempotency-key |
| `pay-order` / `cancel-order` | — | `order-no` from `create-order`; idempotency-key |
| `change-apply` | passenger, segment-id, target date | `product-token` from `change-search`; idempotency-key |
| `change-pay` | — (confirm the fee with the user first) | `change-order-no` + `amount` from `change-detail` |
| `refund-apply` | passenger, segment-id, reason-type, contact-* | idempotency-key |
| `refund-confirm` | confirm (`1` or `2`) | idempotency-key |

### flight-flink specific errors

| Error | Cause | Fix |
|---|---|---|
| `INVALID_ORDER_STATE` | Order not in `AWAITING_PAYMENT` | Check `get-order`; only `AWAITING_PAYMENT` can be paid |
| `PAYORDER_FAILED` | Upstream `payOrder` rejected (e.g. fare expired) | Re-search and re-book |
| `BOOKING_FAILED` | Upstream `createOrder` rejected | Re-verify and retry |
| `PRICE_CHANGED` | Authoritative price differs from the request | Re-verify, confirm the new price with the user |
| `NO_AVAILABILITY` | No flights match | Adjust search criteria |
| `ORDER_CREATE_FAILED` | Upstream order creation error (timeout / rejection) | Retry with the SAME idempotency-key |
| `PAYMENT_FAILED` | Ticketing / settlement failed | Poll `get-order`; re-book if the order is `FAILED` |

## Merchant-specific errors

| Error | Cause | Fix |
|---|---|---|
| `KEY_SCOPE_DENIED` | API key lacks `merchant` scope | Create a key with `--scope merchant` (admin-cli `keys create`) |
| `SERVICE_NOT_FOUND` | Unknown id passed to `services get`, or the CLI does not register that `cli_noun` | Run `services list` for valid ids |
| `QUOTE_EXPIRED` | `quote_id` is too old | Re-run `quote` and book with a fresh `quote_id` |
| `VEHICLE_UNAVAILABLE` | Chosen vehicle class no longer available | Re-quote and pick an available class |
| `BOOKING_FAILED` | Provider rejected the booking | Re-quote and retry; verify passenger details |
| `CANCELLATION_NOT_ALLOWED` | Order is past the cancellable state | Cannot be cancelled |
| `PARAM_IDEMPOTENCY_KEY_REQUIRED` | `--idempotency-key` missing on a write under `--yes` | Supply a unique key |
| `INVALID_ORDER_STATE` | Order is not in `AWAITING_PAYMENT` | Check status with `get` / `get-order` |
| `BILLING_MODE_MISMATCH` | `billing_mode` is neither `monthly_settlement` nor `pay_per_call` | Check the developer's billing_mode; do not retry blindly |
| `PAYMENT_NOT_COMPLETED` | EVO payment not yet confirmed for this `order_id` | Retry later or use `--watch` |
| `PAYMENT_NOT_FOUND` | No EVO transaction for this `order_id` | Confirm the user paid using the `order_id` as merchantTransID |
| `PAYMENT_AMOUNT_MISMATCH` | EVO amount/currency ≠ order | User must pay the exact `total_amount` in the exact `currency` |
| `NO_AVAILABILITY` | Room / flight no longer available | Re-run `quote` / `search` and pick another option |
| `PRICE_CHANGED` | Price changed since quote/verify | Re-quote / re-verify and re-confirm with the user |

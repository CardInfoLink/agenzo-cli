# Merchant-CLI E2E Snapshot — Original Backend (PycharmProjects/agenzo)

> Generated: 2026-06-11T17:30+08:00
> Backend: http://localhost:8000 (PycharmProjects/agenzo, FastAPI + MongoDB)
> CLI: agenzo-cli/apps/merchant-cli/dist/index.js (v0.1.0)
> API Key: sk_test_REDACTED
> Developer: dev_01KTTY4RB8GTYM89XGVNF40S1P
> Purpose: Compare output consistency after switching to the agenzo-platform backend

---

## 1. services list

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "services": [
    {
      "service_id": "ride-elife",
      "name": "Ride hailing (eLife)",
      "category": "ride",
      "provider": "elife",
      "cli_noun": "ride-elife"
    }
  ]
}
```
Exit: 0

Note: services list is a local-only command (CLI built-in registry), does not call the backend API.

---

## 2. services get ride-elife

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "service_id": "ride-elife",
  "name": "Ride hailing (eLife)",
  "description": "On-demand ride ordering: quote a fare, book it, poll status, and cancel.",
  "category": "ride",
  "version": "1.0.0",
  "provider": "elife",
  "cli_noun": "ride-elife",
  "verbs": ["quote", "book", "get", "cancel", "list-orders"],
  "verb_descriptions": {
    "quote": "Request fare quotes for a ride between two points.",
    "book": "Book a ride using a quote_id returned by quote.",
    "get": "Retrieve a ride order by id (poll for status changes with --watch).",
    "cancel": "Cancel a ride order by id (may incur a fee).",
    "list-orders": "List previously placed ride orders."
  },
  "workflow": ["quote", "book", "get (poll for status)", "cancel (optional)"],
  "since": "2026-06-01",
  "discovery": {
    "help_command": "agenzo-merchant-cli ride-elife --help"
  }
}
```
Exit: 0

Note: services get is also a local-only command.

---

## 3. ride-elife list-orders

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "orders": [],
  "total": 0,
  "page": 1,
  "page_size": 20
}
```
Exit: 0

### Backend raw response (curl)
```json
{
  "code": "0000",
  "message": "Ride orders retrieved.",
  "data": [],
  "total": 0,
  "page": 1,
  "page_size": 20
}
```

---

## 4. ride-elife get (not found)

### JSON (stderr)
```json
{"error":{"code":"RESOURCE_NOT_FOUND","code_num":2001,"message":"The resource was not found or does not belong to the current organization."}}
```
Exit: 1

### Backend raw response (curl)
```json
{
  "code": "1905",
  "message": "Ride order not found.",
  "data": {}
}
```

---

## 5. ride-elife cancel (not found)

### JSON (stderr)
```json
{"error":{"code":"RESOURCE_NOT_FOUND","code_num":2001,"message":"The resource was not found or does not belong to the current organization."}}
```
Exit: 1

### Backend raw response (curl)
```json
{
  "code": "1905",
  "message": "Ride order not found.",
  "data": {}
}
```

---

## 6. ride-elife quote

### JSON (success)
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "vehicle_classes": [
    {
      "vehicle_class": "Sedan",
      "vehicle_class_id": 1,
      "price": {
        "amount": 13.77,
        "currency": "USD",
        "quote_id": "e06f518d277c4178a52e950e25e89184-1-0-v1"
      },
      "passenger_capacity": 3,
      "luggage_capacity": 3,
      "typical_vehicle": { "model": "Mini" },
      "image_url": "https://elifetransfer.s3.us-east-2.amazonaws.com/..."
    },
    {
      "vehicle_class": "EV Business Sedan",
      "vehicle_class_id": 42,
      "price": {
        "amount": 13.77,
        "currency": "USD",
        "quote_id": "e06f518d277c4178a52e950e25e89184-1-0-v42"
      },
      "passenger_capacity": 3,
      "luggage_capacity": 3,
      "typical_vehicle": { "model": "Model 3" },
      "image_url": "https://elifelimo.s3.us-east-2.amazonaws.com/..."
    }
  ],
  "meet_and_greet": {
    "price": { "amount": 1.38, "currency": "USD" }
  },
  "add_service": {
    "children": { "price": { "amount": 0, "currency": "USD", "quote_id": "...-c" } },
    "infant": { "price": { "amount": 0, "currency": "USD", "quote_id": "...-i" } },
    "toddler": { "price": { "amount": 0, "currency": "USD", "quote_id": "...-t" } }
  }
}
```
Exit: 0

**CLI command:**
```bash
agenzo-merchant-cli ride-elife quote \
  --api-key $KEY \
  --pickup-lat 31.1443439 --pickup-lng 121.808273 --pickup-name "Pudong airport" \
  --dropoff-lat 31.1807836 --dropoff-lng 121.4854407 --dropoff-name "pudong guozhan road No.1899" \
  --passenger-name "Test User" --passenger-phone "+8613800138000" \
  --pickup-time 1783774800 --passenger-count 1 \
  --yes --format json
```

---

## 7. ride-elife book (success, monthly_settlement)

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "ride_id": "4112785",
  "order_id": "rio_01KTV2EFGMKXP7WCE4D3WGAGBX",
  "status": "INIT",
  "is_scheduled": true,
  "order_type": "airport",
  "price": {
    "amount": 13.77,
    "currency": "USD",
    "quote_id": "c4a146663ed34ede865b458527d04625-2-0-v1"
  },
  "payment_status": "ON_ACCOUNT",
  "billing_entry_id": "ble_01KTV2EFGMKXP7WCE4D3WGAGBY"
}
```
Exit: 0

**CLI command:**
```bash
agenzo-merchant-cli ride-elife book \
  --api-key $MS_KEY \
  --quote-id "c4a146663ed34ede865b458527d04625-2-0-v1" \
  --vehicle-class "Sedan" \
  --price-amount 13.77 --price-currency USD \
  --passenger-name "Test User" --passenger-phone "+8613800138000" \
  --passenger-email "e2e-monthly@test.com" \
  --pickup-lat 31.1443439 --pickup-lng 121.808273 --pickup-name "Pudong airport" \
  --dropoff-lat 31.1807836 --dropoff-lng 121.4854407 --dropoff-name "pudong guozhan road No.1899" \
  --pickup-time 1783774800 \
  --idempotency-key e2e-book-ms-003 \
  --yes --format json
```

Note: book requires a monthly_settlement developer + active settlement account (balance >= fare in minor units, stored as integer not string) + --passenger-email (eLife requirement).

---

## 8. ride-elife get (success)

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "ride_id": "4112785",
  "status": "Pending",
  "source": "mock",
  "from_location": {
    "lat": 1.3644,
    "lng": 103.9915,
    "name": "Changi Airport"
  },
  "to_location": {
    "lat": 1.2834,
    "lng": 103.8607,
    "name": "Marina Bay"
  },
  "pickup_time": "now",
  "vehicle_class": "Sedan",
  "price": {
    "amount": 15,
    "currency": "USD"
  }
}
```
Exit: 0

Note: get uses `ride_id` (external ID returned by eLife: "4112785"), not `order_id` (internal ID: "rio_...")

---

## 9. ride-elife list-orders (with data)

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "orders": [
    {
      "order_id": "rio_01KTV2EFGMKXP7WCE4D3WGAGBX",
      "ride_id": "4112785",
      "status": "Pending",
      "vehicle_class": "Sedan",
      "is_scheduled": true,
      "scheduled_at": "2026-07-11T13:00:00+00:00",
      "price_amount": 13.77,
      "final_amount": 13.77,
      "price_currency": "USD",
      "payment_status": "ON_ACCOUNT",
      "final_settlement_status": "not_applicable",
      "cancellation_fee": null,
      "provider": "elife",
      "created_at": "2026-06-11T10:08:08+00:00",
      "updated_at": "2026-06-11T10:09:07+00:00"
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 20
}
```
Exit: 0

---

## 10. ride-elife cancel (success)

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "ride_id": "4112785",
  "ride_stat": "Cancelled",
  "cancellation": {
    "reversal_amount": 100,
    "cancellation_fee": 0,
    "currency": "USD"
  },
  "refund_amount": 13.77
}
```
Exit: 0

Note: cancel also uses `ride_id` (external ID), not `order_id` (internal ID)

---

## 11. Upstream diagnostic fields in error output (eLife upstream errors)

When a ride-elife command fails due to an eLife upstream error, the CLI stderr error JSON includes an additional `upstream` field carrying the original eLife error code and message. This field is optional, for diagnostics only, and its content is unstable.

### Example: ride-elife book rejected by upstream eLife

#### JSON (stderr)
```json
{"error":{"code":"BOOKING_FAILED","code_num":4203,"message":"The booking could not be completed. Please retry.","request_id":"req_01KPX...","upstream":{"code":"400","message":"Person count mismatch"}}}
```
Exit: 1

### Example: ride-elife quote expired

#### JSON (stderr)
```json
{"error":{"code":"QUOTE_EXPIRED","code_num":4202,"message":"The quote has expired. Please request a new one.","request_id":"req_01KPX...","upstream":{"code":"410","message":"Quote expired or not found"}}}
```
Exit: 1

Notes:
- The `upstream` field only appears when the error originates from the eLife upstream service.
- The top-level `code` / `message` are always the CLI contract's fixed text, not raw eLife content.
- Consumers should not branch on `upstream` field content (unstable, diagnostics only).
- When eLife is unreachable (network timeout, etc.), `upstream.code` is `"NETWORK_ERROR"`.
- Non-eLife upstream errors (e.g., local validation failures, pure backend business errors) do not include the `upstream` field.

---

## Key Comparison Dimensions (check after switching to platform)

1. **Backend envelope**: `{code:"0000", message:..., data:...}` format maintained
2. **Ride orders pagination**: `{data:[], total, page, page_size}` structure
3. **Error code mapping**: backend `1905` (ride not found) maps to CLI `RESOURCE_NOT_FOUND` (2001)
4. **services commands**: local-only, not backend-dependent, should still work after platform switch
5. **X-Api-Key auth**: same as token-cli
6. **ride-elife quote/book**: requires eLife external service to be reachable; both backends should behave identically (both forward to eLife)
7. **list-orders fields**: orders array + total + page + page_size

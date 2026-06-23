# Merchant-CLI E2E Snapshot — Original Backend (PycharmProjects/agenzo)

> 生成时间: 2026-06-11T17:30+08:00
> 后端: http://localhost:8000 (PycharmProjects/agenzo, FastAPI + MongoDB)
> CLI: agenzo-cli/apps/merchant-cli/dist/index.js (v0.1.0)
> API Key: sk_test_REDACTED
> Developer: dev_01KTTY4RB8GTYM89XGVNF40S1P
> 用途: 切换到 agenzo-platform 后端后, 对比输出是否一致

---

## 已知问题

- ride-elife quote 和 book 依赖外部 eLife API, 本地环境该服务不可达 (超时)
- merchant-cli 默认 `--format json` (与 admin/token-cli 默认 table 不同)

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

注: services list 是纯本地命令 (CLI 内置 registry), 不调用后端 API.

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

注: services get 也是纯本地命令.

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

### 后端原始响应 (curl)
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

### 后端原始响应 (curl)
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

### 后端原始响应 (curl)
```json
{
  "code": "1905",
  "message": "Ride order not found.",
  "data": {}
}
```

---

## 6. ride-elife quote

### JSON (成功)
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
      "typical_vehicle": { "model": "迷你" },
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

**CLI 命令:**
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

## 7. ride-elife book (成功, monthly_settlement)

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

**CLI 命令:**
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

注: book 需要 monthly_settlement developer + active settlement account (balance >= fare in minor units, 存为 integer 非 string) + --passenger-email (eLife 要求).

---

## 8. ride-elife get (成功)

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

注: get 使用 `ride_id` (eLife 返回的外部ID: "4112785"), 不是 `order_id` (内部ID: "rio_...")

---

## 9. ride-elife list-orders (有数据)

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

## 10. ride-elife cancel (成功)

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

注: cancel 也用 `ride_id` (外部ID), 不是 `order_id` (内部ID)

---

## 11. 错误输出中的 upstream 诊断字段（eLife 上游错误）

当 ride-elife 命令因 eLife 上游错误而失败时，CLI stderr 的错误 JSON 中会额外携带 `upstream` 字段，承载 eLife 原始错误码与错误信息。该字段为可选，仅用于诊断，内容不稳定。

### 示例：ride-elife book 因上游 eLife 拒绝而失败

#### JSON (stderr)
```json
{"error":{"code":"BOOKING_FAILED","code_num":4203,"message":"The booking could not be completed. Please retry.","request_id":"req_01KPX...","upstream":{"code":"400","message":"Person count mismatch"}}}
```
Exit: 1

### 示例：ride-elife quote 因报价过期而失败

#### JSON (stderr)
```json
{"error":{"code":"QUOTE_EXPIRED","code_num":4202,"message":"The quote has expired. Please request a new one.","request_id":"req_01KPX...","upstream":{"code":"410","message":"Quote expired or not found"}}}
```
Exit: 1

注:
- `upstream` 字段仅在错误源自 eLife 上游服务时出现。
- 顶层 `code` / `message` 始终为 CLI 契约定义的固定文案，不含 eLife 原始内容。
- 消费者不应基于 `upstream` 字段内容做分支判断（该字段不稳定、仅供诊断）。
- 当 eLife 不可达（网络超时等）时，`upstream.code` 为 `"NETWORK_ERROR"`。
- 非 eLife 上游错误（如本地校验失败、纯后端业务错误）不会出现 `upstream` 字段。

---

## 关键对比维度 (切 platform 后检查)

1. **后端信封**: `{code:"0000", message:..., data:...}` 格式保持
2. **ride orders 分页**: `{data:[], total, page, page_size}` 结构
3. **错误码映射**: 后端 `1905` (ride not found) → CLI `RESOURCE_NOT_FOUND` (2001)
4. **services 命令**: 纯本地, 不依赖后端, platform 切换后应仍正常
5. **X-Api-Key 认证**: 与 token-cli 相同
6. **ride-elife quote/book**: 需要 eLife 外部服务可达, 两个后端行为应一致 (都转发到 eLife)
7. **list-orders 字段**: orders array + total + page + page_size

# Token-CLI E2E Snapshot — Original Backend (PycharmProjects/agenzo)

> 生成时间: 2026-06-11T17:30+08:00
> 后端: http://localhost:8000 (PycharmProjects/agenzo, FastAPI + MongoDB)
> CLI: agenzo-cli/apps/token-cli/dist/index.js (v0.1.0)
> API Key: sk_test_REDACTED
> Developer: dev_01KTTY4RB8GTYM89XGVNF40S1P (e2e-test-dev-renamed)
> 用途: 切换到 agenzo-platform 后端后, 对比输出是否一致

---

## 已知问题

- token-cli 在 `--format json` 模式下, 部分命令(list/get)输出为空 (CLI 侧 renderWithContext bug, 非后端问题)
- 需要 `--yes` flag 避免挂起在交互式 prompt
- payment-tokens 操作需要 ACTIVE 状态的 payment-method (需完成 3DS 验证)

---

## 1. payment-methods add

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "pm_01KTV0EAS4KT0V34SGVAY28ESY",
  "type": "card",
  "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
  "member_id": null,
  "status": "PENDING",
  "verification_url": "https://counter-uat.everonet.com/3ds?...",
  "created_at": "2026-06-11T09:33:03+00:00"
}
```
Exit: 0

### 后端原始响应 (curl)
```json
{
  "code": "0000",
  "message": "3DS verification email sent. Please check inbox and complete verification.",
  "data": {
    "id": "pm_01KTV00YBJQ4QSQ65Z8YZQ7CHV",
    "type": "card",
    "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
    "member_id": null,
    "status": "PENDING",
    "verification_url": "https://counter-uat.everonet.com/3ds?...",
    "created_at": "2026-06-11T09:26:07+00:00"
  }
}
```

---

## 2. payment-methods list

### Table
```
ID                             Type  Brand  First 6  Last 4  Status  
-----------------------------  ----  -----  -------  ------  --------
pm_01KTTZVDXNW40TWGN5SSHZA02Q  card  -      -        -       DISABLED
pm_01KTV00YBJQ4QSQ65Z8YZQ7CHV  card  -      -        -       PENDING 
```
Exit: 0

### 后端原始响应 (curl)
```json
{
  "code": "0000",
  "message": "Payment method list retrieved.",
  "data": []
}
```
(注: data=[] 因为这是用另一个 developer 的视角; 同 developer 有数据时 data 是 array of PM objects)

---

## 3. payment-methods get

### Table (PENDING pm)
无输出 (CLI json 模式 bug)
Exit: 0

### 后端原始响应 (curl)
```json
{
  "code": "0000",
  "message": "Payment method retrieved.",
  "data": {
    "id": "pm_...",
    "type": "card",
    "developer_id": "dev_...",
    "member_id": null,
    "email": "e2e@test.com",
    "brand": "mastercard",
    "last4": "0010",
    "first6": "222300",
    "exp_month": 12,
    "exp_year": 2030,
    "status": "ACTIVE",
    "created_at": "..."
  }
}
```

### 错误: not found (table)
```
✗ [2001] The resource was not found or does not belong to the current organization.
```
Exit: 1

---

## 4. payment-methods disable

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "pm_01KTV00YBJQ4QSQ65Z8YZQ7CHV",
  "status": "DISABLED",
  "disabled_at": "2026-06-11T09:32:17+00:00",
  "revoked_payment_tokens_count": 0
}
```
Exit: 0

### 后端原始响应 (curl)
```json
{
  "code": "0000",
  "message": "Payment method disabled. Active payment tokens revoked.",
  "data": {
    "id": "pm_01KTTZVDXNW40TWGN5SSHZA02Q",
    "status": "DISABLED",
    "disabled_at": "2026-06-11T09:25:03+00:00",
    "revoked_payment_tokens_count": 0
  }
}
```

---

## 5. payment-tokens list

### Table (empty)
```
ℹ No payment tokens found
```
Exit: 0

### 后端原始响应 (curl)
```json
{
  "code": "0000",
  "message": "Payment token list retrieved.",
  "data": []
}
```

---

## 6. payment-tokens create (network_token)

### 后端响应
```json
{
  "code": "0000",
  "message": "Payment token created.",
  "data": {
    "id": "ptk_01KTV0VG136YE9YHKVR566AHYN",
    "type": "network_token",
    "payment_method_id": "pm_01KTV0NNJC2028RBS3WWANQWPG",
    "external_transaction_id": null,
    "status": "ACTIVE",
    "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
    "member_id": null,
    "created_at": "2026-06-11T09:40:15+00:00",
    "markup_fee_cents": 0,
    "markup_rate": 0,
    "preauth_total_cents": 0,
    "last_synced_at": null,
    "sync_lag_seconds": null,
    "network_token": {
      "payment_brand": "Mastercard",
      "eci": "06",
      "token_cryptogram": "APxcSJy1loeVAAREC46DAAADFA==",
      "expiry_date": "0729",
      "value": "2223001889757881",
      "created_at": 1781170815
    }
  }
}
```

---

## 7. payment-tokens list

### 后端响应
```json
{
  "code": "0000",
  "message": "Payment token list retrieved.",
  "data": [
    {
      "id": "ptk_01KTV0VG136YE9YHKVR566AHYN",
      "type": "network_token",
      "payment_method_id": "pm_01KTV0NNJC2028RBS3WWANQWPG",
      "external_transaction_id": null,
      "status": "ACTIVE",
      "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
      "member_id": null,
      "created_at": "2026-06-11T09:40:15+00:00",
      "markup_fee_cents": 0,
      "markup_rate": 0,
      "preauth_total_cents": 0,
      "last_synced_at": null,
      "sync_lag_seconds": null,
      "network_token": {
        "payment_brand": "Mastercard",
        "eci": "06",
        "token_cryptogram": "APxcSJy1loeVAAREC46DAAADFA==",
        "expiry_date": "0729",
        "value": "2223001889757881",
        "created_at": 1781170815
      }
    }
  ]
}
```

---

## 8. payment-tokens get

### 后端响应
```json
{
  "code": "0000",
  "message": "Payment token retrieved.",
  "data": {
    "id": "ptk_01KTV0VG136YE9YHKVR566AHYN",
    "type": "network_token",
    "payment_method_id": "pm_01KTV0NNJC2028RBS3WWANQWPG",
    "external_transaction_id": null,
    "status": "ACTIVE",
    "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
    "member_id": null,
    "created_at": "2026-06-11T09:40:15+00:00",
    "markup_fee_cents": 0,
    "markup_rate": 0,
    "preauth_total_cents": 0,
    "last_synced_at": null,
    "sync_lag_seconds": null,
    "network_token": {
      "payment_brand": "Mastercard",
      "eci": "06",
      "token_cryptogram": "APxcSJy1loeVAAREC46DAAADFA==",
      "expiry_date": "0729",
      "value": "2223001889757881",
      "created_at": 1781170815
    }
  }
}
```

### 错误: not found
```json
{
  "code": "1501",
  "message": "Payment token not found.",
  "data": {}
}
```

---

## 9. payment-tokens revoke

### 后端响应
```json
{
  "code": "0000",
  "message": "Payment token revoked.",
  "data": {
    "id": "ptk_01KTV0TZ6JXMC3QW0PYDXM2Y0H",
    "status": "ACTIVE",
    "expires_at": "2026-06-16T09:40:53+00:00",
    "message": "Revoke already requested. Cryptogram will auto-expire."
  }
}
```

---

## 10. payment-methods get (ACTIVE, 3DS verified)

### 后端响应
```json
{
  "code": "0000",
  "message": "Payment method retrieved.",
  "data": {
    "id": "pm_01KTV0NNJC2028RBS3WWANQWPG",
    "type": "card",
    "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
    "member_id": null,
    "status": "ACTIVE",
    "created_at": "2026-06-11T09:37:04+00:00",
    "brand": "MasterCard",
    "last4": "4586",
    "first6": "222300",
    "exp_month": 12,
    "exp_year": 2033
  }
}
```

---

## 关键对比维度 (切 platform 后检查)

1. **后端信封格式**: `{code:"0000", message:..., data:...}` — platform 必须保持一致
2. **字段名**: snake_case 一致
3. **payment-methods add 返回**: id + type + developer_id + member_id + status + verification_url + created_at
4. **payment-methods get (ACTIVE)**: id + type + developer_id + member_id + status + created_at + brand + last4 + first6 + exp_month + exp_year
5. **payment-methods disable 返回**: id + status + disabled_at + revoked_payment_tokens_count
6. **payment-tokens create (network_token)**: id + type + payment_method_id + status + network_token{payment_brand, eci, token_cryptogram, expiry_date, value, created_at}
7. **payment-tokens list**: data 是数组, 每项含完整 token 数据含嵌套 network_token/vcn
8. **错误码映射**: 后端 `1501` (token not found) / `1201` (pm not found) → 对应 HTTP 4xx
9. **X-Api-Key 认证**: header 名 `X-Api-Key`, key 做 SHA256 hash 后与 DB 中 key_hash 比对
10. **network_token 字段**: payment_brand/eci/token_cryptogram/expiry_date/value/created_at

# Token-CLI E2E Snapshot — Original Backend (PycharmProjects/agenzo)

> Generated: 2026-06-11T17:30+08:00
> Backend: http://localhost:8000 (PycharmProjects/agenzo, FastAPI + MongoDB)
> CLI: agenzo-cli/apps/token-cli/dist/index.js (v0.1.0)
> API Key: sk_test_REDACTED
> Developer: dev_01KTTY4RB8GTYM89XGVNF40S1P (e2e-test-dev-renamed)
> Purpose: Compare output consistency after switching to the agenzo-platform backend

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

### Backend raw response (curl)
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

### Backend raw response (curl)
```json
{
  "code": "0000",
  "message": "Payment method list retrieved.",
  "data": []
}
```
(Note: data=[] because this is from a different developer's perspective; when the same developer has data, data is an array of PM objects)

---

## 3. payment-methods get

### Backend raw response (curl)
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

### Error: not found (table)
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

### Backend raw response (curl)
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

### Backend raw response (curl)
```json
{
  "code": "0000",
  "message": "Payment token list retrieved.",
  "data": []
}
```

---

## 6. payment-tokens create (network_token)

### Backend response
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

### Backend response
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

### Backend response
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

### Error: not found
```json
{
  "code": "1501",
  "message": "Payment token not found.",
  "data": {}
}
```

---

## 9. payment-tokens revoke

### Backend response
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

### Backend response
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

## Key Comparison Dimensions (check after switching to platform)

1. **Backend envelope format**: `{code:"0000", message:..., data:...}` — platform must maintain consistency
2. **Field names**: snake_case consistent
3. **payment-methods add response**: id + type + developer_id + member_id + status + verification_url + created_at
4. **payment-methods get (ACTIVE)**: id + type + developer_id + member_id + status + created_at + brand + last4 + first6 + exp_month + exp_year
5. **payment-methods disable response**: id + status + disabled_at + revoked_payment_tokens_count
6. **payment-tokens create (network_token)**: id + type + payment_method_id + status + network_token{payment_brand, eci, token_cryptogram, expiry_date, value, created_at}
7. **payment-tokens list**: data is an array, each item contains full token data including nested network_token/vcn
8. **Error code mapping**: backend `1501` (token not found) / `1201` (pm not found) maps to corresponding HTTP 4xx
9. **X-Api-Key auth**: header name `X-Api-Key`, key is SHA256 hashed and compared with key_hash in DB
10. **network_token fields**: payment_brand/eci/token_cryptogram/expiry_date/value/created_at

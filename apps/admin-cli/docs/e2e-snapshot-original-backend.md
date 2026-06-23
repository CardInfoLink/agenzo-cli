# Admin-CLI E2E Snapshot — Original Backend (PycharmProjects/agenzo)

> Generated: 2026-06-11T16:50+08:00
> Backend: http://localhost:8000 (PycharmProjects/agenzo, FastAPI + MongoDB)
> CLI: agenzo-cli/apps/admin-cli/dist/index.js (v0.1.1)
> Purpose: Compare output consistency after switching to the agenzo-platform backend

---

## Test Data

| Entity | ID | Notes |
|---|---|---|
| Organization | org_01KT35C83PGV2HG554WFC0VR2G | Acme Inc. / henry.li@cardinfolink.com |
| Developer (pay_per_call) | dev_01KTTY4RB8GTYM89XGVNF40S1P | e2e-test-dev-renamed / e2e-updated@test.com |
| Developer (monthly_settlement) | dev_01KTTY8129K2P4CXWE1DF6A8F6 | e2e-monthly-dev / e2e-monthly@test.com |
| Settlement Account | acct_01KTTY812B338736GM38EXRRE2 | balance=100000 USD |
| API Key (active) | key_01KTTY5FGV31MPJSZZYR59HAMT | E2E Key, scope=token,merchant,payment |
| API Key (disabled) | key_01KTTY5FNMZ9XD0TTDTKWWDESF | E2E Key JSON, scope=token,merchant |

---

## 1. config show

### Table
```
API Host    http://localhost:8000/
API Path    /api/v3/agent-pay
Active Org  org_01KT35C83PGV2HG554WFC0VR2G
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "api_host": "http://localhost:8000/",
  "api_path": "/api/v3/agent-pay",
  "active_org": "org_01KT35C83PGV2HG554WFC0VR2G"
}
```
Exit: 0

---

## 2. config set-host (credential match)

### Table
```
✓ API host set to: http://localhost:8000/
ℹ Switched to organization: Acme Inc. (org_01KT35C83PGV2HG554WFC0VR2G)
API Host    http://localhost:8000/
Active Org  org_01KT35C83PGV2HG554WFC0VR2G
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "api_host": "http://localhost:8000/",
  "active_org": "org_01KT35C83PGV2HG554WFC0VR2G"
}
```
Exit: 0

---

## 2b. config set-host (no credential match)

### Table
```
✓ API host set to: http://localhost:8000
ℹ No organization found for this host. Please run login.
API Host    http://localhost:8000
Active Org  (none)
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "api_host": "http://localhost:8000",
  "active_org": null
}
```
Exit: 0

---

## 3. config reset-host

### Table
```
✓ API host reset to: https://agent.everonet.com
ℹ No organization found for this host. Please run login.
API Host    https://agent.everonet.com
Active Org  (none)
```

### JSON
```json
{
  "profile": "production",
  "endpoint": "https://agent.everonet.com",
  "api_host": "https://agent.everonet.com",
  "active_org": null
}
```
Exit: 0

---

## 4. orgs get

### Table
```
Org ID   org_01KT35C83PGV2HG554WFC0VR2G
Name     Acme Inc.
Email    henry.li@cardinfolink.com
Status   ACTIVE
Created  2026-06-02 11:17:31 (UTC+08:00)
Updated  2026-06-02 15:18:27 (UTC+08:00)
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "Acme Inc.",
  "email": "henry.li@cardinfolink.com",
  "status": "ACTIVE",
  "created_at": "2026-06-02T03:17:31+00:00",
  "updated_at": "2026-06-02T07:18:27+00:00"
}
```
Exit: 0

---

## 5. orgs update --name

### Table
```
✓ Organization updated
Org ID  org_01KT35C83PGV2HG554WFC0VR2G
Name    Acme Inc.
Email   henry.li@cardinfolink.com
Status  ACTIVE
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "Acme Inc.",
  "email": "henry.li@cardinfolink.com",
  "status": "ACTIVE",
  "created_at": "2026-06-02T03:17:31+00:00",
  "updated_at": "2026-06-11T08:51:49+00:00"
}
```
Exit: 0

---

## 6. orgs update --email

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "Acme Inc.",
  "email": "henry.li@cardinfolink.com",
  "status": "ACTIVE",
  "created_at": "2026-06-02T03:17:31+00:00",
  "updated_at": "2026-06-11T08:51:49+00:00"
}
```
Exit: 0

---

## 7. orgs list

### Table
```
   Org ID                          Org Name   Email                    
-  ------------------------------  ---------  -------------------------
*  org_01KT35C83PGV2HG554WFC0VR2G  Acme Inc.  henry.li@cardinfolink.com
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "organizations": [
    {
      "org_id": "org_01KT35C83PGV2HG554WFC0VR2G",
      "org_name": "Acme Inc.",
      "email": "henry.li@cardinfolink.com",
      "active": true
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```
Exit: 0

---

## 8. orgs switch

### Success (JSON)
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "active_org": "org_01KT35C83PGV2HG554WFC0VR2G"
}
```
Exit: 0

### Failure: org not found (JSON)
```json
{"error":{"code":"CLIENT_NOT_SIGNED_IN","code_num":9001,"message":"Organization org_NOTEXIST not signed in locally"}}
```
Exit: 1

---

## 9. developers list

### Table
```
ID                              Name           Email                      Status
------------------------------  -------------  -------------------------  ------
dev_01KT35MMPJ1F7XH854WZ9YWSXX  bot-prod       oncall@acme.com            ACTIVE
dev_01KT3KFVGKKRGZDNM0CPVCMJV1  dayewang       dota@dota.com              ACTIVE
dev_01KTK4KF520PE1NNK41T4WC867  lxh-test       henry.li@cardinfolink.com  ACTIVE
dev_01KTR49GXDC3BPTR33Z5X4NMM3  bot-ms-72live  bot-ms-72live@example.com  ACTIVE
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "developers": [
    {
      "id": "dev_01KT35MMPJ1F7XH854WZ9YWSXX",
      "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
      "name": "bot-prod",
      "email": "oncall@acme.com",
      "status": "ACTIVE",
      "billing_mode": "pay_per_call",
      "created_at": "2026-06-02T03:22:06+00:00",
      "updated_at": "2026-06-02T03:22:07+00:00"
    },
    {
      "id": "dev_01KT3KFVGKKRGZDNM0CPVCMJV1",
      "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
      "name": "dayewang",
      "email": "dota@dota.com",
      "status": "ACTIVE",
      "billing_mode": "pay_per_call",
      "created_at": "2026-06-02T07:24:10+00:00",
      "updated_at": "2026-06-02T07:30:45+00:00"
    },
    {
      "id": "dev_01KTK4KF520PE1NNK41T4WC867",
      "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
      "name": "lxh-test",
      "email": "henry.li@cardinfolink.com",
      "status": "ACTIVE",
      "billing_mode": "pay_per_call",
      "created_at": "2026-06-08T08:11:50+00:00",
      "updated_at": "2026-06-08T08:11:50+00:00"
    },
    {
      "id": "dev_01KTR49GXDC3BPTR33Z5X4NMM3",
      "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
      "name": "bot-ms-72live",
      "email": "bot-ms-72live@example.com",
      "status": "ACTIVE",
      "billing_mode": "monthly_settlement",
      "created_at": "2026-06-10T06:42:37+00:00",
      "updated_at": "2026-06-10T06:42:37+00:00"
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```
Exit: 0

---

## 10. developers get

### Table
```
ID            dev_01KT35MMPJ1F7XH854WZ9YWSXX
Name          bot-prod
Email         oncall@acme.com
Status        ACTIVE
Billing Mode  pay_per_call
Created       2026-06-02 11:22:06 (UTC+08:00)
Updated       2026-06-02 11:22:07 (UTC+08:00)
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "dev_01KT35MMPJ1F7XH854WZ9YWSXX",
  "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "bot-prod",
  "email": "oncall@acme.com",
  "status": "ACTIVE",
  "billing_mode": "pay_per_call",
  "created_at": "2026-06-02T03:22:06+00:00",
  "updated_at": "2026-06-02T03:22:07+00:00"
}
```
Exit: 0

### Error: not found
```json
{"error":{"code":"RESOURCE_NOT_FOUND","code_num":2001,"message":"The resource was not found or does not belong to the current organization."}}
```
Exit: 1

---

## 11. developers create

### Table (pay_per_call)
```
✓ Developer created
ID            dev_01KTTY4RB8GTYM89XGVNF40S1P
Org ID        org_01KT35C83PGV2HG554WFC0VR2G
Name          e2e-test-dev
Email         e2e@test.com
Status        ACTIVE
Billing Mode  pay_per_call
```

### JSON (pay_per_call)
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "dev_01KTTY4RG0DHA70XPBVACFQKT5",
  "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "e2e-test-dev-json",
  "email": "e2e-json@test.com",
  "status": "ACTIVE",
  "billing_mode": "pay_per_call",
  "created_at": "2026-06-11T08:52:52+00:00",
  "updated_at": "2026-06-11T08:52:52+00:00"
}
```
Exit: 0

### JSON (monthly_settlement)
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "dev_01KTTY8129K2P4CXWE1DF6A8F6",
  "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "e2e-monthly-dev",
  "email": "e2e-monthly@test.com",
  "status": "ACTIVE",
  "billing_mode": "monthly_settlement",
  "created_at": "2026-06-11T08:54:39+00:00",
  "updated_at": "2026-06-11T08:54:39+00:00"
}
```
Exit: 0

### Error: invalid billing-mode
```json
{"error":{"code":"PARAM_INVALID","code_num":2101,"message":"Invalid --billing-mode: weekly. Allowed: pay_per_call, monthly_settlement."}}
```
Exit: 1

---

## 12. developers update

### Table
```
✓ Developer updated
ID      dev_01KTTY4RB8GTYM89XGVNF40S1P
Name    e2e-test-dev-renamed
Email   e2e@test.com
Status  ACTIVE
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
  "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "name": "e2e-test-dev-renamed",
  "email": "e2e-updated@test.com",
  "status": "ACTIVE",
  "billing_mode": "pay_per_call",
  "created_at": "2026-06-11T08:52:52+00:00",
  "updated_at": "2026-06-11T08:53:04+00:00"
}
```
Exit: 0

### Error: not found
```json
{"error":{"code":"RESOURCE_NOT_FOUND","code_num":2001,"message":"The resource was not found or does not belong to the current organization."}}
```
Exit: 1

---

## 13. keys create

### Table
```
✓ API Key created
⚠ API Key: sk_test_REDACTED
⚠ Save it now — this key is shown only once
Name    E2E Key
Scope   token, merchant, payment
Status  ACTIVE
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "key_01KTTY5FNMZ9XD0TTDTKWWDESF",
  "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
  "name": "E2E Key JSON",
  "api_key": "sk_test_REDACTED",
  "key_prefix": "sk_test_",
  "scope": [
    "token",
    "merchant"
  ],
  "status": "ACTIVE",
  "created_at": "2026-06-11T08:53:16+00:00"
}
```
Exit: 0

---

## 14. keys list

### Table
```
ID                              Developer                       Name          Scope                   Status  Last Used
------------------------------  ------------------------------  ------------  ----------------------  ------  ---------
key_01KTTY5FGV31MPJSZZYR59HAMT  dev_01KTTY4RB8GTYM89XGVNF40S1P  E2E Key       token,merchant,payment  ACTIVE  Never
key_01KTTY5FNMZ9XD0TTDTKWWDESF  dev_01KTTY4RB8GTYM89XGVNF40S1P  E2E Key JSON  token,merchant          ACTIVE  Never
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "keys": [
    {
      "id": "key_01KTTY5FGV31MPJSZZYR59HAMT",
      "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
      "name": "E2E Key",
      "key_prefix": "sk_test_",
      "scope": ["token", "merchant", "payment"],
      "status": "ACTIVE",
      "created_at": "2026-06-11T08:53:16+00:00",
      "last_used_at": ""
    },
    {
      "id": "key_01KTTY5FNMZ9XD0TTDTKWWDESF",
      "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
      "name": "E2E Key JSON",
      "key_prefix": "sk_test_",
      "scope": ["token", "merchant"],
      "status": "ACTIVE",
      "created_at": "2026-06-11T08:53:16+00:00",
      "last_used_at": ""
    }
  ],
  "page": {
    "next_cursor": null,
    "has_more": false
  }
}
```
Exit: 0

---

## 15. keys get

### Table
```
Key ID        key_01KTTY5FGV31MPJSZZYR59HAMT
Developer ID  dev_01KTTY4RB8GTYM89XGVNF40S1P
Name          E2E Key
Scope         token, merchant, payment
Status        ACTIVE
Last Used     Never
Created       2026-06-11 16:53:16 (UTC+08:00)
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "key_01KTTY5FGV31MPJSZZYR59HAMT",
  "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
  "name": "E2E Key",
  "key_prefix": "sk_test_",
  "scope": ["token", "merchant", "payment"],
  "status": "ACTIVE",
  "created_at": "2026-06-11T08:53:16+00:00",
  "last_used_at": ""
}
```
Exit: 0

### Error: not found
```json
{"error":{"code":"RESOURCE_NOT_FOUND","code_num":2001,"message":"The resource was not found or does not belong to the current organization."}}
```
Exit: 1

---

## 16. keys rotate

### Table
```
✓ API Key rotated
⚠ New API Key: sk_test_REDACTED
⚠ Save it now — this key is shown only once
Key ID  key_01KTTY5FNMZ9XD0TTDTKWWDESF
Name    E2E Key JSON
Scope   token, merchant
Status  ACTIVE
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "key_01KTTY5FGV31MPJSZZYR59HAMT",
  "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
  "name": "E2E Key",
  "api_key": "sk_test_REDACTED",
  "scope": ["token", "merchant", "payment"],
  "status": "ACTIVE",
  "created_at": "2026-06-11T08:53:16+00:00",
  "rotated_at": "2026-06-11T08:54:17+00:00"
}
```
Exit: 0

---

## 17. keys disable

### Table
```
✓ API Key key_01KTTY5FNMZ9XD0TTDTKWWDESF disabled
Status  DISABLED
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "key_01KTTY5FNMZ9XD0TTDTKWWDESF",
  "developer_id": "dev_01KTTY4RB8GTYM89XGVNF40S1P",
  "name": "E2E Key JSON",
  "status": "DISABLED",
  "disabled_at": "2026-06-11T08:54:29+00:00"
}
```
Exit: 0

---

## 18. accounts get (monthly_settlement developer, has balance)

### Table
```
Account ID    acct_01KTTY812B338736GM38EXRRE2
Developer ID  dev_01KTTY8129K2P4CXWE1DF6A8F6
Balance       100000
Currency      USD
Status        active
Created       2026-06-11 16:54:39 (UTC+08:00)
Updated       2026-06-11 16:56:39 (UTC+08:00)
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "id": "acct_01KTTY812B338736GM38EXRRE2",
  "developer_id": "dev_01KTTY8129K2P4CXWE1DF6A8F6",
  "organization_id": "org_01KT35C83PGV2HG554WFC0VR2G",
  "balance": "100000",
  "currency": "USD",
  "status": "active",
  "created_at": "2026-06-11T08:54:39+00:00",
  "updated_at": "2026-06-11T08:56:39+00:00"
}
```
Exit: 0

---

## 18b. accounts get (pay_per_call developer, no account)

### Table
```
Account ID    undefined
Developer ID  undefined
Balance       undefined
Currency      undefined
Status        undefined
Created       
Updated       
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "code": "0000",
  "message": "No settlement account found for this developer.",
  "data": null
}
```
Exit: 0

---

## 19. auth logout

### Table
```
✓ Signed out
```

### JSON
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "signed_out": true
}
```
Exit: 0

### Error: not signed in (already logged out)
Backend behavior: returns signed_out:true (no error, succeeds directly)
```json
{
  "profile": "custom",
  "endpoint": "http://localhost:8000",
  "signed_out": true
}
```
Exit: 0

---

## 20. Unauthenticated state — calling commands that require auth

### orgs get (not signed in)
```json
{"error":{"code":"CLIENT_NOT_SIGNED_IN","code_num":9001,"message":"Not signed in"}}
```
Exit: 1

---

## Error Scenarios Summary

### Missing idempotency-key
```json
{"error":{"code":"PARAM_IDEMPOTENCY_KEY_REQUIRED","code_num":2102,"message":"`orgs update` requires --idempotency-key <key>. Supply a unique key so the write can be safely retried."}}
```
Exit: 1

### Resource not found (developers/keys)
```json
{"error":{"code":"RESOURCE_NOT_FOUND","code_num":2001,"message":"The resource was not found or does not belong to the current organization."}}
```
Exit: 1

### Invalid billing-mode
```json
{"error":{"code":"PARAM_INVALID","code_num":2101,"message":"Invalid --billing-mode: weekly. Allowed: pay_per_call, monthly_settlement."}}
```
Exit: 1

### Org not signed in locally
```json
{"error":{"code":"CLIENT_NOT_SIGNED_IN","code_num":9001,"message":"Organization org_NOTEXIST not signed in locally"}}
```
Exit: 1

---

## Key Comparison Dimensions (check after switching to platform)

1. **JSON field names fully consistent** — snake_case, same field set
2. **Envelope structure** — `profile`/`endpoint` prefix + business fields
3. **list commands** — include `page` pagination object
4. **Error envelope** — `{"error":{"code","code_num","message"}}`
5. **Exit codes** — 0/1/3 mapping correct
6. **accounts get** — has account returns entity, no account returns `{code:"0000", message:..., data:null}`
7. **billing_mode** — passed at creation, echoed in response
8. **scope** — array format, returned in create/list/get/rotate
9. **Time format** — ISO-8601 UTC offset `+00:00`
10. **balance** — string type (not number)

# agenzo-token-cli Test Design Document

> This document is the test design for `agenzo-token-cli`, aligned with the spec (`requirements.md` / `design.md` / `tasks.md`) and `doc/architecture-upgrade/v1/cli-design.md` section 3 (command field-level specification).
> Scope = **8 command matrix** + 7 cross-cutting consistency constraints (output format / exit codes / error envelope / idempotency key / output channel purity / type mapping / get-create difference preservation).
> Authority order: cli-standard.md > cli-design.md section 3 > design.md.
> Repository: `agenzo-cli/apps/token-cli` (binary `agenzo-token-cli`), TypeScript + commander@14 + vitest + tsup.

---

## 1. Test Objectives and Scope

### 1.1 Objectives

1. Verify that all 8 commands' input/output/HTTP behavior is character-for-character consistent with cli-design section 3.4 field-level specification.
2. Verify that API Key authentication (`X-Api-Key`) is correctly included in all 8 commands.
3. Verify that `--idempotency-key` is mandatory for 4 write commands (`--yes` missing key produces `PARAM_IDEMPOTENCY_KEY_REQUIRED`/exit 1 without sending a request).
4. Verify that `--format json` mode stdout contains only valid JSON (including profile/endpoint envelope), stderr completely silent; `--format table` mode status lines go to stderr.
5. Verify error code consolidation (external codes belong to section 8 catalog) and exit code mapping (KEY_*->3, TOKEN_*/CLIENT_*/PARAM_*->1, UPSTREAM_/INTERNAL_/RATE_LIMITED->4, CLIENT_ABORTED->5).
6. Verify `payment-tokens create` composite logic: type mapping, payment method resolution priority, VCN amount without floating-point drift, three type branches.
7. Verify `payment-tokens get` vs `create` keyValue differences are preserved character-for-character (Property 7).

### 1.2 In Scope

- 8 commands: `payment-methods add/list/get/disable` + `payment-tokens create/list/get/revoke`.
- Global flags: `--format` (json/table, default table), `--yes`, `--verbose`.
- API Key auth model (`--api-key` -> `X-Api-Key` header).
- `CliError.fromApi` with `{auth:'api-key'}` parameterization (401->KEY_INVALID, 403->KEY_SCOPE_DENIED).
- `renderWithContext` (profile/endpoint envelope, BACK-011).
- 3DS polling (payment-methods add).
- `--mode` dispatch for `payment-methods add`: `manual` (collect card + 3DS polling, default) and `dropin` (Drop-in session create + verification polling, terminal ACTIVE/FAILED/EXPIRED, no idempotency key).
- VCN fee calculation (string->cents without floating-point).
- Network-token fee fallback.
- X402 USDC calculation.
- Payment method resolution 4-level priority.
- `formatPaymentToken` (create) vs `formatPaymentTokenGet` (get) difference preservation.

### 1.3 Out of Scope

- admin-cli auth/config/orgs/developers/keys/accounts commands (section 2).
- merchant-cli / payment-cli (sections 4/5).
- Backend API actual deduplication behavior (only verify CLI-side header forwarding, not server-side idempotency).
- Backend 3DS email sending behavior (CLI-side only verifies polling logic).
- CLI OS keychain / credential store (token-cli has no Bearer credentials).

---

## 2. Test Layering Strategy

| Layer | Tool | Network Required | Coverage Target | Priority |
|---|---|---|---|---|
| L1 Unit Tests | vitest, pure functions | No | `usdToCents` / `mapTokenType` / `resolvePaymentMethod` / `formatPaymentToken` / `formatPaymentTokenGet` / `getSummary` | P0 (required) |
| L2 Property Tests (PBT) | vitest + fast-check | No | Amount without floating-point drift / type mapping full domain / exit code mapping domain | P0 (required) |
| L3 Command Integration (CLI mock) | vitest + mock ApiClient | No | 8 commands happy path + key branches | P0 (required) |
| L4 Command Smoke (CLI E2E) | Compiled binary + real testing host | Yes | 8 commands end-to-end | P1 (manual) |
| L5 Cross-cutting Consistency | vitest + capture stdout/stderr | No | Idempotency key / output channel / error codes / get-create differences | P0 (required) |

---

## 3. Test Environment and Prerequisites

### 3.1 Build

```bash
npm install
npm run build -w @agenzo/cli-core   # must build cli-core first
npm run build -w @agenzo/token-cli
npm test                             # vitest run (full suite)
```

### 3.2 Backend Environment (for L4 manual tests)

- Testing host: `https://agent-test.everonet.com`
- API path: `/api/v3/agent-pay`
- Requires a valid API Key (issued by `agenzo-admin-cli keys create`)

### 3.3 Common Assertion Tools

- JSON validation: `agenzo-token-cli <cmd> --format json | jq .` must parse successfully.
- Exit code: `echo $?`.
- stdout/stderr separation: `1>out.txt 2>err.txt`.
- json mode stderr silence: `err.txt` must not contain `✓`/`ℹ`/`⚠`/`✗` icons.

---

## 4. L1/L2 Unit Tests and Property Tests (Automated / vitest)

### 4.1 `usdToCents` — VCN amount string to cents without floating-point drift (Property 1 / Req 3.3)

File: `tests/pbt-amount.test.ts`

| Case | Input | Expected |
|---|---|---|
| PBT-AMT-01 | Any valid amount in [0.01, 500.00] (1000 rounds) | `usdToCents(a) === exact cents` (string-split calculation) |
| PBT-AMT-02 | Same as above | `usdToCents(a) === Math.round(parseFloat(a)*100)` (proves consistency) |
| UT-AMT-03 | `"1.005"` (3 decimal places) | Throws PARAM_INVALID |
| UT-AMT-04 | `"0.01"` | Returns 1 |
| UT-AMT-05 | `"500.00"` | Returns 50000 |
| UT-AMT-06 | `"1"` | Returns 100 |
| UT-AMT-07 | `"100"` | Returns 10000 |
| UT-AMT-08 | `"0.10"` (float: 10.000000000000002) | Returns 10 |
| UT-AMT-09 | `"0.29"` (float: 28.999999999999996) | Returns 29 |
| UT-AMT-10 | `"1.1"` (single decimal, padEnd->"10") | Returns 110 |

### 4.2 `mapTokenType` — type mapping stability (Property 2 / Req 3.1)

File: `tests/pbt-type-and-resolve.test.ts`

| Case | Input | Expected |
|---|---|---|
| UT-TYPE-01 | `"vcn"` | `"vcn"` |
| UT-TYPE-02 | `"network-token"` | `"network_token"` |
| UT-TYPE-03 | `"x402"` | `"x402"` |
| PBT-TYPE-04 | Any non-`"network-token"` string (200 rounds) | Original value passed through |
| PBT-TYPE-05 | Random sampling from known 3 mappings (50 rounds) | Always correct |

### 4.3 `resolvePaymentMethod` — payment method resolution priority (Property 3 / Req 3.2)

File: `tests/pbt-type-and-resolve.test.ts`

| Case | Input | Expected |
|---|---|---|
| UT-RES-01 | `--payment-method-id=pm_x` + multiple cards | Returns `pm_x`, API not called |
| UT-RES-02 | `--card=5678` + ACTIVE card with last4=5678 | Returns corresponding pm_id |
| UT-RES-03 | `--card=9999` + no match | Throws `CLIENT_CARD_NOT_MATCHED` |
| UT-RES-04 | No flag + zero ACTIVE cards | Throws `CLIENT_NO_PAYMENT_METHOD` |
| UT-RES-05 | No flag + empty card list | Throws `CLIENT_NO_PAYMENT_METHOD` |
| UT-RES-06 | No flag + single ACTIVE card | Auto-selects that card |
| UT-RES-07 | No flag + multiple ACTIVE cards + `--yes` | Throws `PARAM_INVALID` (cannot prompt) |
| UT-RES-08 | Only considers ACTIVE cards (filters PENDING/DISABLED) | Filters correctly |
| UT-RES-09 | `--card` exact match last4 | Exact match |
| UT-RES-10 | Error is CliError instance | instanceof assertion |

### 4.4 Idempotency key enforcement (Property 4 / Req 6.3)

File: `tests/properties.test.ts`

| Case | Command | Input | Expected |
|---|---|---|---|
| UT-IDEM-01 | `payment-methods disable` | `--yes` without `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| UT-IDEM-02 | `payment-methods add` | `--yes` without `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| UT-IDEM-03 | `payment-tokens create` | `--yes` without `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| UT-IDEM-04 | `payment-tokens revoke` | `--yes` without `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| UT-IDEM-05 | IdempotencyKeyRequiredError construction | `new IdempotencyKeyRequiredError('cmd')` | code=`PARAM_IDEMPOTENCY_KEY_REQUIRED`, message contains `--idempotency-key` |

### 4.5 Output channel purity (Property 5 / Req 6.1)

File: `tests/properties.test.ts`

| Case | Input | Expected |
|---|---|---|
| UT-CHAN-01 | `notify('json','success','x')` | stderr not written |
| UT-CHAN-02 | `notify('table','success','x')` | stderr written once with `✓` |
| UT-CHAN-03 | `notify('json','info','x')` | Silent |
| UT-CHAN-04 | `notify('table','info','x')` | stderr contains `ℹ` |
| UT-CHAN-05 | `payment-methods disable --format json` | stdout is valid JSON with profile/endpoint; stderr empty |
| UT-CHAN-06 | `payment-methods disable --format table` | stdout contains keyValue; stderr contains `✓` status line |

### 4.6 Error code consolidation + exit codes (Property 6 / Req 6.2)

File: `tests/properties.test.ts`

| Case | Input | Expected code | Expected exitCode |
|---|---|---|---|
| UT-ERR-01 | `fromApi({statusCode:401}, {auth:'api-key'})` | KEY_INVALID | 3 |
| UT-ERR-02 | `fromApi({statusCode:403}, {auth:'api-key'})` | KEY_SCOPE_DENIED | 3 |
| UT-ERR-03 | `fromApi({statusCode:404})` | RESOURCE_NOT_FOUND | 1 |
| UT-ERR-04 | `fromApi({statusCode:429})` | RATE_LIMITED | 4 |
| UT-ERR-05 | `fromApi({statusCode:500})` | INTERNAL_ERROR | 4 |
| UT-ERR-06 | `CliError('TOKEN_FEATURE_DISABLED')` | TOKEN_FEATURE_DISABLED | 1 |
| UT-ERR-07 | `CliError('CLIENT_NO_PAYMENT_METHOD')` | CLIENT_NO_PAYMENT_METHOD | 1 |
| UT-ERR-08 | `CliError('CLIENT_CARD_NOT_MATCHED')` | CLIENT_CARD_NOT_MATCHED | 1 |
| UT-ERR-09 | `CliError('PARAM_IDEMPOTENCY_KEY_REQUIRED')` | PARAM_IDEMPOTENCY_KEY_REQUIRED | 1 |
| UT-ERR-10 | `UserCancelError()` | CLIENT_ABORTED | 5 |
| UT-ERR-11 | `CliError('UPGRADE_REQUIRED')` | UPGRADE_REQUIRED | 2 |
| UT-ERR-12 | `CliError('UPSTREAM_ERROR')` | UPSTREAM_ERROR | 4 |
| UT-ERR-13 | All token-cli error codes | `toErrorEnvelope` produces code_num > 0 and non-empty message | -- |

### 4.7 get-create character-for-character alignment (Property 7 / Req 4.2)

File: `tests/properties.test.ts`

| Case | Assertion |
|---|---|
| UT-DIFF-01 | `formatPaymentToken`(VCN) contains `Payment Token ID`; `formatPaymentTokenGet`(VCN) contains `Token ID`, not `Payment Token ID` |
| UT-DIFF-02 | get contains `Last 4` line; create does not |
| UT-DIFF-03 | create Limit line contains `$`; get Limit line does not contain `$` |
| UT-DIFF-04 | get contains `Balance` line; create does not |
| UT-DIFF-05 | network_token: create uses `Payment Token ID`, get uses `Token ID` |
| UT-DIFF-06 | x402: same ID difference as above |

---

## 5. L3 Command Integration Tests (vitest + mock ApiClient)

> Mock granularity: mock `ApiClient` (intercept get/post returning preset responses), do not mock commander (real parseAsync).
> Shared tools: `tests/helpers.ts` (captureStdout / captureStderr / buildProgram / mockApiClient).

### 5.1 `payment-methods add` (section 3.4.0.1)

File: `tests/payment-methods.test.ts`

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PM-ADD-01 | Normal create (status=ACTIVE, skip 3DS) | All flags + `--idempotency-key` | POST /payment-methods/create with X-Api-Key + Idempotency-Key; stderr contains `Payment method created` + `Complete 3DS`; stdout contains pm_id/ACTIVE |
| TC-PM-ADD-02 | 3DS success (PENDING -> poll -> ACTIVE) | status=PENDING, poll returns ACTIVE | stderr contains `Payment method activated` |
| TC-PM-ADD-03 | 3DS failure (PENDING -> poll -> FAILED) | poll returns FAILED | stderr contains `3DS verification failed` |
| TC-PM-ADD-04 | 3DS timeout | poll never terminates (needs fake timer) | stderr contains `Verification timed out (15 min)` + hint command |
| TC-PM-ADD-05 | `--yes` missing `--idempotency-key` | Missing key | Throws IdempotencyKeyRequiredError; post not called |
| TC-PM-ADD-06 | API failure 401 | post returns 401 | Throws CliError code=KEY_INVALID |
| TC-PM-ADD-07 | json mode | `--format json` | stdout valid JSON with profile/endpoint; stderr empty |

### 5.2 `payment-methods list` (section 3.4.0.2)

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PM-LST-01 | Has data | `--api-key k` | GET /payment-methods with X-Api-Key; stdout contains header + data rows |
| TC-PM-LST-02 | Missing fields | brand/first6/last4 are null | Displays `-` |
| TC-PM-LST-03 | Empty list | Returns [] | stdout contains `No payment methods found`; no table header |
| TC-PM-LST-04 | `--member` forwarding | `--member mem_1` | API call contains `{member_id:'mem_1'}` query |
| TC-PM-LST-05 | API failure 403 | Returns 403 | Throws CliError code=KEY_SCOPE_DENIED |

### 5.3 `payment-methods get` (section 3.4.0.3)

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PM-GET-01 | Normal (with Brand/First6/Last4) | `get pm_abc` | GET /payment-methods/pm_abc; stdout keyValue contains all fields |
| TC-PM-GET-02 | Conditional fields missing | brand/first6/last4 empty | stdout does not contain Brand/First 6/Last 4 lines |
| TC-PM-GET-03 | 404 | Returns 404 | Throws CliError code=RESOURCE_NOT_FOUND |

### 5.4 `payment-methods disable` (section 3.4.0.4)

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PM-DIS-01 | Normal disable | `disable pm_001 --api-key k --idempotency-key i` | POST /payment-methods/pm_001/disable (no body, X-Api-Key + Idempotency-Key); stderr `✓ Payment method pm_001 disabled`; stdout contains Status + Revoked tokens |
| TC-PM-DIS-02 | revoked_tokens_count missing | Response lacks this field | Displays `0` |
| TC-PM-DIS-03 | `--yes` missing key | Missing `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| TC-PM-DIS-04 | json mode | `--format json` | stdout JSON contains status + revoked_tokens_count + profile/endpoint |

### 5.5 `payment-tokens create` (section 3.4.1)

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PT-CRT-01 | VCN normal | `--yes --type vcn --amount 25.00 --payment-method-id pm_x --idempotency-key k` | POST body: type=vcn, amount=2500, payment_method_id=pm_x; stdout contains VCN keyValue |
| TC-PT-CRT-02 | VCN feature disabled | GET /features/vcn returns enabled:false | Throws TOKEN_FEATURE_DISABLED |
| TC-PT-CRT-03 | VCN amount out of range | `--amount 600.00` | Throws PARAM_INVALID |
| TC-PT-CRT-04 | VCN fee calculation | amount=10.00 (1000 cents) | fee=max(1,round(1000*0.05))=50; freeze=1050 |
| TC-PT-CRT-05 | Network-token type mapping | `--type network-token` | POST body type=`network_token` |
| TC-PT-CRT-06 | NT fee fallback | GET /config/network-token-fee fails | fee=DEFAULT_NT_FEE_CENTS=500 |
| TC-PT-CRT-07 | X402 normal | All x402 flags | POST body contains pay_to/nonce/network/deadline; stdout contains X402 + `ℹ Use the Signature Value` |
| TC-PT-CRT-08 | X402 fee calculation | amount=1.00 USDC | fee=max(10000, round(1000000*0.05))=50000 |
| TC-PT-CRT-09 | Payment method resolution — single card auto | No --payment-method-id/--card + single ACTIVE card | Auto-selected |
| TC-PT-CRT-10 | Payment method resolution — no card | No ACTIVE cards | Throws CLIENT_NO_PAYMENT_METHOD |
| TC-PT-CRT-11 | Payment method resolution — card no match | `--card 9999` + no match | Throws CLIENT_CARD_NOT_MATCHED |
| TC-PT-CRT-12 | `--yes` missing key | Missing `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| TC-PT-CRT-13 | `--yes` omit `--member` | No `--member` provided | body has no member_id field |
| TC-PT-CRT-14 | Idempotency-Key header forwarding | `--idempotency-key my-key` | HTTP header `Idempotency-Key: my-key` |

### 5.6 `payment-tokens list` (section 3.4.2)

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PT-LST-01 | Has data | Three token types | stdout contains header + getSummary (vcn: `411111****1234 $25.00`, nt: `Visa`, x402: `1000000 Base`) |
| TC-PT-LST-02 | Empty list | Returns [] | stdout contains `No payment tokens found`; no table header |
| TC-PT-LST-03 | `--type`+`--member` forwarding | Two flags | API call contains query params |

### 5.7 `payment-tokens get` (section 3.4.3) — Property 7

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PT-GET-01 | VCN keyValue (Property 7) default masked | VCN response | stdout contains `Token ID` (not `Payment Token ID`) + `Last 4` + Limit without `$` + Balance without `$`; Card Number/CVC masked, no full PAN/CVC |
| TC-PT-GET-02 | Network Token | NT response | stdout contains `Token ID` + Brand/ECI/Cryptogram/Expiry/Value |
| TC-PT-GET-03 | X402 | X402 response | stdout contains `Token ID` + Signature Value/Status |
| TC-PT-GET-04 | 404 | Returns 404 | Throws RESOURCE_NOT_FOUND |
| TC-PT-GET-05 | VCN explicit reveal | `--reveal` | stdout/JSON returns full Card Number/CVC |

### 5.8 `payment-tokens revoke` (section 3.4.4)

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-PT-REV-01 | Immediate revoke | status=REVOKED | stderr `✓ Payment token revoked`; stdout contains Token ID/REVOKED/Revoked At |
| TC-PT-REV-02 | Delayed revoke (X402) | status=ACTIVE + expires_at non-null | stderr `✓ Revoke scheduled (cryptogram will auto-expire)`; stdout contains Token ID/ACTIVE/Expires At + message |
| TC-PT-REV-03 | `--yes` missing key | Missing `--idempotency-key` | Throws IdempotencyKeyRequiredError; post not called |
| TC-PT-REV-04 | json mode | `--format json` | stdout JSON contains profile/endpoint + id/status |

---

## 6. L4 Command-Level Test Cases (manual executable, requires real backend)

> Convention variables: `$API_KEY` (issued by admin-cli keys create), `$PM_ID` (produced after adding a payment method), `$PT_ID` (produced after creating a token).
> Exit code semantics: `0` success, `1` business/param, `2` upgrade required, `3` auth failure/invalid key, `4` network/5xx, `5` user cancel.

### 6.1 `payment-methods add`

```bash
# TC-E2E-PM-ADD-01: Add payment method + 3DS (requires email verification)
agenzo-token-cli payment-methods add \
  --api-key "$API_KEY" --email test@example.com \
  --card-number 4111111111111111 --expiry 1228 --cvv 123 \
  --idempotency-key pm-add-$(date +%s) --format json 1>out.json 2>err.log
echo "exit=$?"
jq . out.json   # valid JSON
PM_ID=$(jq -r '.id' out.json)

# TC-E2E-PM-ADD-02: Invalid API Key
agenzo-token-cli payment-methods add --api-key invalid_key \
  --email a@b.com --card-number 4111111111111111 --expiry 1228 --cvv 123 \
  --idempotency-key k1 2>&1; echo "exit=$?"  # expect 3 (KEY_INVALID)
```

### 6.2 `payment-methods list`

```bash
# TC-E2E-PM-LST-01: List payment methods
agenzo-token-cli payment-methods list --api-key "$API_KEY" --format json | jq .
echo "exit=$?"  # 0

# TC-E2E-PM-LST-02: With member filter
agenzo-token-cli payment-methods list --api-key "$API_KEY" --member mem_none --format json
```

### 6.3 `payment-methods get`

```bash
# TC-E2E-PM-GET-01: Query existing PM
agenzo-token-cli payment-methods get "$PM_ID" --api-key "$API_KEY" --format json | jq .
echo "exit=$?"  # 0

# TC-E2E-PM-GET-02: Not found
agenzo-token-cli payment-methods get pm_notexist --api-key "$API_KEY" 2>&1
echo "exit=$?"  # expect 1 (RESOURCE_NOT_FOUND)
```

### 6.4 `payment-methods disable`

```bash
# TC-E2E-PM-DIS-01: Disable
agenzo-token-cli payment-methods disable "$PM_ID" --api-key "$API_KEY" \
  --idempotency-key pm-dis-$(date +%s) --format json | jq '{status,revoked_tokens_count}'
echo "exit=$?"  # 0
```

### 6.5 `payment-tokens create`（VCN）

```bash
# TC-E2E-PT-CRT-01: Create VCN
agenzo-token-cli --yes payment-tokens create \
  --api-key "$API_KEY" --type vcn --amount 10.00 \
  --payment-method-id "$PM_ID" --idempotency-key pt-crt-$(date +%s) --format json 1>pt.json
echo "exit=$?"; PT_ID=$(jq -r '.id' pt.json)
jq '{id,type,status}' pt.json  # type=vcn, status=ACTIVE

# TC-E2E-PT-CRT-02: VCN feature off (if applicable)
# TC-E2E-PT-CRT-03: amount out of range
agenzo-token-cli --yes payment-tokens create --api-key "$API_KEY" --type vcn \
  --amount 600 --payment-method-id "$PM_ID" --idempotency-key k 2>&1; echo "exit=$?"  # expect 1
```

### 6.6 `payment-tokens list`

```bash
# TC-E2E-PT-LST-01: List
agenzo-token-cli payment-tokens list --api-key "$API_KEY" --format json | jq '.payment_tokens | length'
echo "exit=$?"  # 0
```

### 6.7 `payment-tokens get`

```bash
# TC-E2E-PT-GET-01: Query VCN token
agenzo-token-cli payment-tokens get "$PT_ID" --api-key "$API_KEY" --format json | jq .
echo "exit=$?"  # 0
# Assert: default masks Card Number/CVC; contains Token ID (not Payment Token ID), Limit without $

# TC-E2E-PT-GET-02: Explicit reveal VCN plaintext (only needed for payment flow)
agenzo-token-cli payment-tokens get "$PT_ID" --api-key "$API_KEY" --reveal --format json | jq .
```

### 6.8 `payment-tokens revoke`

```bash
# TC-E2E-PT-REV-01: Revoke
agenzo-token-cli payment-tokens revoke "$PT_ID" --api-key "$API_KEY" \
  --idempotency-key pt-rev-$(date +%s) --format json | jq '{id,status}'
echo "exit=$?"  # 0
```

---

## 7. Cross-cutting Consistency Assertions

### 7.1 API Key Authentication (all 8 commands)

- All commands' HTTP requests carry `X-Api-Key: <value>` header.
- Invalid key -> 401 -> KEY_INVALID -> exit 3.
- Scope mismatch -> 403 -> KEY_SCOPE_DENIED -> exit 3.

### 7.2 Idempotency Key (4 write commands)

- `--yes` + missing `--idempotency-key` -> local interception `PARAM_IDEMPOTENCY_KEY_REQUIRED` (exit 1), **no request sent**.
- Interactive mode missing key -> prompt for input (non-empty validation).
- Key provided -> HTTP header `Idempotency-Key: <value>` forwarded.
- CLI never auto-generates a key.

### 7.3 json mode stderr silence

- All 8 commands in `--format json`: stderr does not contain `✓`/`ℹ`/`⚠`/`✗`.
- stdout is a single valid JSON (with `profile` + `endpoint` fields).
- `notify(format, ...)` is completely silent in json mode.

### 7.4 Exit Code Matrix

| Error prefix | Exit code |
|---|---|
| KEY_* | 3 |
| TOKEN_* / CLIENT_* / PARAM_* | 1 |
| UPSTREAM_* / INTERNAL_* / RATE_LIMITED | 4 |
| CLIENT_ABORTED (SIGINT) | 5 |
| UPGRADE_REQUIRED | 2 |

### 7.5 Error Envelope

On failure, stderr outputs (json mode):

```json
{"error":{"code":"KEY_INVALID","code_num":1101,"message":"...","request_id":"..."}}
```

`request_id` is only present for HTTP-origin errors.

---

## 8. Implemented Automated Test Mapping

| Test File | Covered Cases/Properties | Case Count |
|---|---|---|
| `tests/pbt-amount.test.ts` | PBT-AMT-01~02, UT-AMT-03~10 (Property 1) | 10 |
| `tests/pbt-type-and-resolve.test.ts` | UT-TYPE-01~03, PBT-TYPE-04~05 (Property 2) + UT-RES-01~10 (Property 3) | 16 |
| `tests/payment-methods.test.ts` | TC-PM-ADD-01~05, TC-PM-LST-01~04, TC-PM-GET-01~02, TC-PM-DIS-01~03 | 13 |
| `tests/payment-tokens.test.ts` | TC-PT-CRT-01/05/07/12, TC-PT-LST-01~03, TC-PT-GET-01~05, TC-PT-REV-01~03 | 15 |
| `tests/properties.test.ts` | UT-IDEM-01~05, UT-CHAN-01~06, UT-ERR-01~13, UT-DIFF-01~06 (Properties 4-7) | 27 |
| `tests/coverage-gaps.test.ts` | 3DS timeout (fake timer), JSON envelope exact assertions (3), API error integration (3), VCN fee verification, List JSON structure, Idempotency-Key header exact value (2) | 11 |

**Total: 90 automated tests, all passing.**



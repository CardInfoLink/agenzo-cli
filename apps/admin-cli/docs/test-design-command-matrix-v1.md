# agenzo-admin-cli Test Design Document

> This document is the test design for `agenzo-admin-cli`, aligned with the spec (`requirements.md` / `design.md` / `tasks.md`) and `doc/architecture-upgrade/v1/cli-design.md` §2 (command field-level specification).
> Scope = **19 commands in the matrix (including `accounts get`)** locked for this iteration + 6 cross-cutting consistency constraints (output format / exit codes / error envelope / key redaction / idempotency key forwarding / split fidelity).
> Authoritative order: cli-standard.md > cli-design.md > design.md.
> Repository: this repo (`agenzo-token-cli/`, post-split binary is `agenzo-admin-cli`), TypeScript + commander@14 + vitest + tsup.

---

## 1. Test Objectives and Scope

### 1.1 Objectives

1. Verify that 19 commands' input/output/HTTP behavior matches cli-design §2 field-level specification (split fidelity, Req 7).
2. Verify that 4 consistency improvements (noun-verb grouping, central renderer, exit code mapping, error envelope) conform to cli-standard (Req 1/4/5).
3. Verify that `--idempotency-key` is **required** on 7 server-side write commands (missing → `PARAM_IDEMPOTENCY_KEY_REQUIRED`/exit 1) and correctly forwarded; local write commands reject this flag (Req 4.3 / cli-design §1 "all server-side writes must be idempotent").
4. Verify that secrets (Bearer token, one-time api_key) do not leak to stdout (Req 6).
5. Verify that local state files are persisted to `~/.agenzo-admin-cli/` (Req 2.4).
6. Verify `developers create`'s `--billing-mode` local enum validation (default `pay_per_call`, invalid value → `PARAM_INVALID`/exit 1) and `accounts get`'s query/no-account/cross-Org behavior (cli-design §2.4.10 / §2.4.19).
7. Verify **json mode stderr completely silences status lines**: when `--format json`, all commands (not just the 7 write commands) suppress success/info/progress status lines (`✓`/`ℹ`, spinner, `Magic link sent`, etc.) entirely (not even to stderr), enabling other Agents to parse without interference; in table mode these status lines go to stderr as normal (Req 4.1/4.4).

### 1.2 In Scope

- 19 commands: `auth login/logout`, `config set-host/show/reset-host`, `orgs get/update/list/switch`, `developers create/list/get/update`, `keys create/list/get/rotate/disable`, `accounts get`.
- `developers create`'s `--billing-mode` flag (`pay_per_call` | `monthly_settlement`, default `pay_per_call`, local validation) and `Developer.billing_mode` pass-through/display.
- `keys create`'s `--scope` flag (`token` / `merchant` / `payment` subset, default all three, local validation); scope is persisted by the backend (`ap_api_keys.scope`) and returned in create/list/get/rotate responses; legacy documents without scope fall back to all three on the backend.
- Central renderer `resolveFormat` / `render`, exit code mapping `exitCodeFor`, error catalog `errorCodeFor` / `toErrorEnvelope`.
- Local enum validators `resolveBillingMode` (`developers/billing-mode.ts`), `parseScopeFlag` / `resolveScopes` (`keys/scope.ts`).
- `--format` (`json | table`, default `table`), `AGENZO_FORMAT` environment variable.
- `--idempotency-key` forwarding.

### 1.3 Out of Scope

- Backend settlement account creation (only for monthly_settlement) / rollback consistency server-side logic (belongs to `agenzo` backend tests, see `tests/agent_pay/test_account_service.py` / `test_developer_service.py`); CLI side only verifies `accounts get` request and rendering.
- API Key scope **authorization enforcement** (`KEY_SCOPE_DENIED`, rejecting runtime CLI calls outside the key's scope) — belongs to backend BACK-034; this iteration the backend only persists + echoes scope, does not enforce authorization; CLI side does not verify authorization rejection.
- `billing_mode` switching flow (offline admin operation, CLI does not provide update).
- Backend idempotency deduplication implementation (BACK-090) — only verifies CLI-side header forwarding (Property 6), not server-side deduplication.
- Profile model, OS keychain, `--help --format json` capability discovery.
- Backend numeric ↔ enum error code full mapping (only verifies domain-prefixed SCREAMING_SNAKE codes).
- Legacy `~/.agenzo-token-cli/` directory migration.

---

## 2. Test Layering Strategy

| Layer | Tool | Network Required | Coverage Target | Priority |
| --- | --- | --- | --- | --- |
| L1 Unit Test | vitest, pure functions | No | `resolveFormat` / `render` / `exitCodeFor` / `errorCodeFor` / `toErrorEnvelope` | P0 (required) |
| L2 Property-Based Test (PBT) | vitest + fast-check | No | Full-domain invariants for exit code / error code mapping | P2 (optional, task 9.5 marked with `*`) |
| L3 Command Integration / Smoke (CLI E2E) | Compiled artifact `agenzo-admin-cli` + real testing host | Partial | 18 commands end-to-end input/output/exit codes | P1 (manual, documented in README) |
| L4 Split Fidelity Review (Diff Review) | Code review + git diff | No | Migrated commands' HTTP method/path/body/read fields match pre-split behavior | P1 |

> Note: Unit tests are the only new automated tests added in this iteration (tasks 9.1–9.5). Command-level tests are provided as **manually executable steps** (this document §4/§5) for dev and QA to reproduce step-by-step; they are not required to be written as vitest integration cases (which depend on a real backend).

---

## 3. Test Environment and Prerequisites

### 3.1 Build

```bash
npm install
npm run build          # tsup outputs dist/index.js, bin = agenzo-admin-cli
npm link               # or invoke directly via node dist/index.js
agenzo-admin-cli --version
```

### 3.2 Backend Environment

- Testing host: `https://agent-test.everonet.com` (or local `http://localhost:8000`).
- API path: `/api/v3/agent-pay` (default).
- At least one email inbox capable of receiving mail for magic-link login (use team-agreed test email per existing conventions).

### 3.3 Local State Directory

- All commands persist local state to `~/.agenzo-admin-cli/`:
  - `config.json` (`active_org` / `api_host` / `api_path`)
  - `credentials/<org_id>.json` (contains token, **never goes to stdout**)
  - `keys.json` (one-time api_key cache)
- Before each test suite, it is recommended to back up and clear this directory for reproducibility:

```bash
mv ~/.agenzo-admin-cli ~/.agenzo-admin-cli.bak.$(date +%s) 2>/dev/null || true
```

### 3.4 Common Assertion Tools

- JSON shape validation: `agenzo-admin-cli <cmd> --format json | jq .` must parse successfully (stdout is a single valid JSON).
- Exit code validation: immediately after command run `echo $?`.
- stdout/stderr separation validation: `agenzo-admin-cli <cmd> --format json 1>out.txt 2>err.txt`, assert `out.txt` contains only payload, logs/hints go to `err.txt`.
- **json mode stderr silence validation**: `agenzo-admin-cli <cmd> --format json 1>/dev/null 2>err.txt`, assert `err.txt` contains no status icons (`✓`/`ℹ`/`⚠`) or human-readable status text; compare with same command in `table` mode where `err.txt` should contain these status lines.
- Secret leak validation: `grep -E "access_token|refresh_token" out.txt` must have no matches.

### 3.5 Global Flag Conventions

- `--format <json|table>`: overrides default `table`.
- `--yes`: disables interactive prompts (for CI / Agent use).
- `--verbose`: verbose logging (→ stderr).
- `--idempotency-key <key>`: only accepted by the 7 server-side write commands.

---

## 4. L1 Unit Test Cases (Cross-Cutting Consistency, Automated / vitest)

> These are the automated tests that must be implemented in this iteration (tasks 9.1–9.4, PBT 9.5 optional). Files located in `tests/**/*.test.ts`. Each case is annotated with: case number, corresponding requirement/property, input, steps, expected output.

### 4.1 `resolveFormat` — Output Format Resolution (Property 2 / Req 4.2)

File: `tests/output-format.test.ts`

| Case | Input (flag, env) | Steps | Expected Output |
| --- | --- | --- | --- |
| UT-FMT-01 | flag=`json`, env=`table` | Call `resolveFormat('json', 'table')` | Returns `'json'` (flag takes priority over env) |
| UT-FMT-02 | flag=`table`, env=`json` | Call `resolveFormat('table', 'json')` | Returns `'table'` |
| UT-FMT-03 | flag=undefined, env=`json` | Call `resolveFormat(undefined, 'json')` | Returns `'json'` (env is next priority) |
| UT-FMT-04 | flag=undefined, env=undefined | Call `resolveFormat(undefined, undefined)` | Returns `'table'` (default value, intentional deviation from cli-standard §5.1) |
| UT-FMT-05 | flag=`xml` (invalid) | Call `resolveFormat('xml')` | Returns `'table'` (invalid value falls back to default) |
| UT-FMT-06 | env=`yaml` (invalid), flag=undefined | Call `resolveFormat(undefined, 'yaml')` | Returns `'table'` (invalid env falls back to default) |
| UT-FMT-07 | flag=`JSON` (case mismatch) | Call `resolveFormat('JSON')` | Per implementation convention: case mismatch treated as invalid → `'table'` (assert the implementation's determined behavior, documented in test case) |
| UT-FMT-08 | Any input | Iterate above | Return value is always ∈ `{'json','table'}` |

Test step template:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveFormat } from '../src/utils/output';

describe('resolveFormat', () => {
  it('flag wins over env', () => {
    expect(resolveFormat('json', 'table')).toBe('json');
  });
  it('falls back to table on invalid', () => {
    expect(resolveFormat('xml')).toBe('table');
  });
  // ... UT-FMT-01..08
});
```

### 4.2 `render` — Central Renderer (Property 1 & 5 / Req 4.1, 6.1)

File: `tests/output-render.test.ts`

| Case | Input | Steps | Expected |
| --- | --- | --- | --- |
| UT-RND-01 | `result.data = {a:1,b:'x'}`, format=`json` | Capture stdout, call `render(result,{format:'json'})` | stdout round-trips through `JSON.parse` to deep-equal `result.data` |
| UT-RND-02 | Same as above | Assert stdout does not contain human-readable text from `result.text()` (no `✓`/key-value headers) | stdout contains only JSON |
| UT-RND-03 | `format=table` | Capture stdout, call `render` | stdout === return value of `result.text()` |
| UT-RND-04 | `result.data` contains `api_key: 'agz_live_sk_xxx'` (keys create) | format=json | stdout contains `api_key` (caller needs it), but does not contain `access_token`/`refresh_token` |
| UT-RND-05 | `result.data` is an object with `access_token` (constructed abnormal input) | format=json | Renderer only outputs `data`; assert no token field names are written to stdout (verifies tokens are stripped during data construction) |
| UT-RND-06 | `result.note='Signed in'` | format=json | `note` does **not** appear in stdout (note is only for stderr success hints) |
| UT-RND-07 | `data` is an array (orgs list / developers list) | format=json | stdout is a valid JSON array, element fields match data |

> Capture stdout with `vi.spyOn(process.stdout, 'write')`; assert stderr isolation with `vi.spyOn(process.stderr, 'write')`.

### 4.3 `exitCodeFor` — Exit Code Mapping (Property 3 / Req 5.1)

File: `tests/exit.test.ts` (each row corresponds to one row in the design "error class → exit code matrix")

| Case | Input (thrown instance) | Expected Exit Code |
| --- | --- | --- |
| UT-EXIT-01 | `UpgradeRequiredError` | 2 |
| UT-EXIT-02 | `AuthError` (not signed in) | 3 |
| UT-EXIT-03 | `AuthError` (session/refresh) | 3 |
| UT-EXIT-04 | `AuthError` (magic-link timeout) | 3 |
| UT-EXIT-05 | `ApiBusinessError` statusCode=401 | 3 |
| UT-EXIT-06 | `ApiBusinessError` statusCode=403 | 3 |
| UT-EXIT-07 | `ApiBusinessError` statusCode=404 | 1 |
| UT-EXIT-08 | `ApiBusinessError` statusCode=409 | 1 |
| UT-EXIT-09 | `ApiBusinessError` statusCode=429 | 1 |
| UT-EXIT-10 | `ApiBusinessError` statusCode=422 (other 4xx) | 1 |
| UT-EXIT-11 | `ApiBusinessError` statusCode=500 (5xx) | 4 |
| UT-EXIT-12 | `ValidationError` | 1 |
| UT-EXIT-13 | `ConfigError` | 1 |
| UT-EXIT-14 | `NetworkError` | 4 |
| UT-EXIT-15 | `UserCancelError` (SIGINT) | 5 |
| UT-EXIT-16 | `new Error('boom')` (unknown throwable) | 1 |
| UT-EXIT-17 | `'string error'` / `null` / `undefined` | 1 (fallback for non-Error input) |
| UT-EXIT-18 | Any input | Return value is always ∈ `{1,2,3,4,5}`, never 0 / undefined |

### 4.4 `errorCodeFor` / `toErrorEnvelope` — Error Catalog (Property 4 / Req 5.2)

File: `tests/errors.test.ts`

| Case | Input | Expected `code` | Expected `http` |
| --- | --- | --- | --- |
| UT-ERR-01 | `UpgradeRequiredError` | `UPGRADE_REQUIRED` | Omitted or corresponding value |
| UT-ERR-02 | `AuthError` (not signed in) | `AUTH_NOT_SIGNED_IN` | Omitted (local) |
| UT-ERR-03 | `AuthError` (session expired) | `AUTH_SESSION_EXPIRED` | Omitted |
| UT-ERR-04 | `AuthError` (timeout) | `AUTH_TIMEOUT` | Omitted |
| UT-ERR-05 | `ApiBusinessError` 401 | `AUTH_INVALID_API_KEY` or `AUTH_FAILED` | 401 |
| UT-ERR-06 | `ApiBusinessError` 403 | `KEY_SCOPE_DENIED` or `AUTH_FAILED` | 403 |
| UT-ERR-07 | `ApiBusinessError` 404 (orgs noun context) | `ORG_NOT_FOUND` | 404 |
| UT-ERR-08 | `ApiBusinessError` 404 (keys noun context) | `KEY_NOT_FOUND` | 404 |
| UT-ERR-09 | `ApiBusinessError` 409 | `ORG_CONFLICT` | 409 |
| UT-ERR-10 | `ApiBusinessError` 429 | `RATE_LIMITED` | 429 |
| UT-ERR-11 | `ApiBusinessError` other 4xx | `PARAM_INVALID` | Corresponding 4xx |
| UT-ERR-12 | `ApiBusinessError` 5xx | `UPSTREAM_UNAVAILABLE` | 5xx |
| UT-ERR-13 | `ValidationError` | `PARAM_INVALID` | Omitted |
| UT-ERR-14 | `ConfigError` | `INTERNAL_ERROR` | Omitted |
| UT-ERR-15 | `NetworkError` | `UPSTREAM_UNAVAILABLE` | Omitted (no HTTP status locally) |
| UT-ERR-16 | `UserCancelError` | `USER_CANCELLED` | Omitted |
| UT-ERR-17 | Unknown throwable | `INTERNAL_ERROR` | Omitted |
| UT-ERR-18 | Any input | `code` ∈ `ErrorCode` union and non-empty; `message` non-empty | — |
| UT-ERR-19 | `toErrorEnvelope` output structure | `{ error: { code, message, http? } }`, `http` present only for HTTP-origin errors | — |

### 4.5 PBT Property-Based Tests (Optional, task 9.5)

File: `tests/mappers.pbt.test.ts` (fast-check)

| Case | Generator | Invariant |
| --- | --- | --- |
| PBT-01 | Random `statusCode` (100–599) + random error class | `exitCodeFor(e)` is always ∈ `{1,2,3,4,5}` |
| PBT-02 | Any throwable (string/number/object/Error subclass) | `errorCodeFor(e)` always returns an `ErrorCode` union member |
| PBT-03 | Any throwable | `toErrorEnvelope(e).error.code` is non-empty and `message` is non-empty |

```typescript
import fc from 'fast-check';
it('exitCodeFor always in 1..5', () => {
  fc.assert(fc.property(fc.anything(), (e) => {
    const c = exitCodeFor(e);
    return [1, 2, 3, 4, 5].includes(c);
  }));
});
```

### 4.6 Server-Side Write Commands Require `--idempotency-key` (Property 6 / Req 4.3)

File: `tests/idempotency-required.test.ts`

The 7 server-side write commands (`auth login` / `orgs update` / `developers create` / `developers update` / `keys create` / `keys rotate` / `keys disable`) all **require** `--idempotency-key`. When missing, they throw `IdempotencyKeyRequiredError` before any network call (→ `PARAM_IDEMPOTENCY_KEY_REQUIRED` / exit 1). This test covers the 3 commands that were previously "optional forwarding" and are now required (login / rotate / disable).

| Case | Input | Expected |
| --- | --- | --- |
| UT-IDEM-01 | `login --email a@b.com` (no --idempotency-key) | Throws `IdempotencyKeyRequiredError`; `authService.login` not called |
| UT-IDEM-02 | `rotate key_x` (no --idempotency-key) | Throws `IdempotencyKeyRequiredError`; `apiClient` not called |
| UT-IDEM-03 | `disable key_x` (no --idempotency-key) | Throws `IdempotencyKeyRequiredError`; `apiClient` not called |
| UT-IDEM-04 | `new IdempotencyKeyRequiredError('keys rotate')` | message contains command name + `--idempotency-key` hint |

> Uses commander `root.exitOverride()` + stub deps, asserts handler throws on missing key without reaching the network layer. orgs update / developers create/update / keys create use the same `IdempotencyKeyRequiredError` pattern (already implemented).

### 4.7 `resolveBillingMode` — --billing-mode Local Validation (Req 5.3 / cli-design §2.4.10)

File: `tests/billing-mode.test.ts`

`developers create`'s `--billing-mode` is validated locally: defaults to `pay_per_call` when omitted, normalizes case/whitespace, throws `ValidationError` on invalid values (→ `PARAM_INVALID` / exit 1), consistent with `keys --scope` local validation pattern.

| Case | Input | Steps | Expected |
| --- | --- | --- | --- |
| UT-BILL-01 | flag=undefined | `resolveBillingMode(undefined)` | Returns `'pay_per_call'` (default); `DEFAULT_BILLING_MODE==='pay_per_call'` |
| UT-BILL-02 | flag=`pay_per_call` | `resolveBillingMode('pay_per_call')` | Returns `'pay_per_call'` |
| UT-BILL-03 | flag=`monthly_settlement` | `resolveBillingMode('monthly_settlement')` | Returns `'monthly_settlement'` |
| UT-BILL-04 | flag=`  Monthly_Settlement ` | `resolveBillingMode('  Monthly_Settlement ')` | Normalization (lowercase + trim whitespace) → `'monthly_settlement'` |
| UT-BILL-05 | flag=`weekly` (invalid) | `resolveBillingMode('weekly')` | Throws `ValidationError` (→ PARAM_INVALID / exit 1) |

```typescript
import { describe, it, expect } from 'vitest';
import { resolveBillingMode, DEFAULT_BILLING_MODE } from '../src/developers/billing-mode';
import { ValidationError } from '../src/utils/errors';

describe('resolveBillingMode', () => {
  it('defaults to pay_per_call', () => {
    expect(resolveBillingMode(undefined)).toBe('pay_per_call');
  });
  it('throws on unknown value', () => {
    expect(() => resolveBillingMode('weekly')).toThrow(ValidationError);
  });
  // ... UT-BILL-01..05
});
```

### 4.8 `config set-host` / `reset-host` Output Deduplication (Regression GAPA-049 / Req 4.1, 4.4, 4.5)

File: `tests/config-output.test.ts`

Historical bug: `applyHost` used both `notify()` (stderr) and `CommandResult.text()` (stdout) to output the same status line, causing each line to print twice in table mode. After the fix, `text()` only returns the payload projection, and status lines are exclusively handled by `notify` via stderr.

| Case | Input | Expected |
| --- | --- | --- |
| TC-CFG-SET-DEDUP-01 | `set-host` (no matching credential, table) | stdout contains `API Host`/`Active Org`, does not contain any status icons (✓/ℹ/⚠/✗) or status text |
| TC-CFG-SET-DEDUP-02 | Same as above | stderr contains `API host set to` exactly 1 time (no duplication) |
| TC-CFG-SET-DEDUP-03 | `set-host` (credential match found) | stdout contains active_org value, does not contain `Switched to organization`; stderr Switched line appears only once |
| TC-CFG-SET-DEDUP-04 | `set-host` + `AGENZO_FORMAT=json` | stdout is valid JSON (`{api_host, active_org}`); json mode notify is silent |
| TC-CFG-RST-DEDUP-05 | `reset-host` (table) | Consistent with set-host: stdout has no status icons, stderr status lines appear only once |

> Capture method: `vi.spyOn(process.stdout,'write')` + `vi.spyOn(console,'error')` to collect both streams separately; stub `configManager`/`credentialStore` to avoid real file dependencies.

### 4.9 json Mode stderr Silence (Cross-Cutting, Req 4.1/4.4)

File: `tests/json-quiet.test.ts` (or merged into each command handler test)

This iteration converges "json mode outputs only JSON, stderr status lines are also silenced" into the central helper `notify(format, type, message)`: in `json` mode it returns immediately (does not write to stderr); in `table` mode it writes `console.error(Formatter.status(...))`. The login flow spinner (which uses stdout) is disabled in quiet mode. Error envelopes are still output by the top-level `reportError` (not through notify) and are unaffected.

| Case | Input | Expected |
| --- | --- | --- |
| TC-QUIET-01 | `notify('json','success','x')` | Does not write to stderr (spy asserts 0 calls) |
| TC-QUIET-02 | `notify('table','success','x')` | Writes to stderr 1 time, contains `✓ x` |
| TC-QUIET-03 | Any successful command with `--format json` actual run | stderr does not contain `✓`/`ℹ`/`⚠` status icons; stdout is valid JSON |
| TC-QUIET-04 | Same command in `table` mode actual run | stderr contains corresponding status lines |
| TC-QUIET-05 | `auth login --format json` | Spinner (`Waiting for email verification`) and `Magic link sent` do not appear (quiet disables spinner + notify is silent) |
| TC-QUIET-06 | json mode failure (e.g., not logged in `orgs get --format json`) | stdout is empty (no partial payload); stderr contains only `{"error":{...}}` envelope; exit code per matrix |

### 4.10 Server-Side Write Commands Missing Idempotency Key: Interactive Prompt vs --yes Throws (Req 4.3)

File: `tests/idempotency-required.test.ts` (same file as §4.6)

Strategy has been adjusted from "missing → immediate failure" to: **interactive mode missing → prompt for input** (with non-empty validation); **`--yes` non-interactive mode missing → throws `IdempotencyKeyRequiredError`** (prompt would hang, so must throw). CLI never auto-generates a key.

| Case | Input | Expected |
| --- | --- | --- |
| TC-IDEM-YES-01 | `auth login --email e --yes` (no key) | Throws `IdempotencyKeyRequiredError`; does not reach authService; exit 1 |
| TC-IDEM-YES-02 | `keys rotate id --yes` (no key) | Throws `IdempotencyKeyRequiredError`; does not reach apiClient; exit 1 |
| TC-IDEM-YES-03 | `keys disable id --yes` (no key) | Same as above |
| TC-IDEM-INT-01 | Interactive mode (not --yes) missing key | Shows prompt `Idempotency key (unique per write, for safe retry):`; empty input triggers non-empty validation; input provided → continues |

> Tests use `root.option('--yes')` mirroring the global flag + `optsWithGlobals().yes` to trigger the throw path; the interactive prompt path is not exercised in automation with real stdin (would hang), covered by §5 manual cases.

---

## 5. L3 Command-Level Test Cases (Per Command, Manually Executable)

> One section per command, uniform structure: **case table** (positive/negative/boundary) + **execution steps** (copy-pasteable commands) + **expected assertions**.
> Variable conventions: `$EMAIL`, `$ORG_ID`, `$DEV_ID`, `$KEY_ID`, `$API_KEY` are produced in preceding steps and reused.
> Exit code semantics: `0` success · `1` business/parameter(4xx) · `2` upgrade required · `3` auth failure/invalid key · `4` network/5xx · `5` user cancelled.

### 5.1 `auth login` (W, magic-link, server-side write, [idem])

Covers: Req 1.2, 2.1, 2.2, 2.5, 4.1, 4.3, 6.1; cli-design §2.4.1.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-AUTH-LOGIN-01 | New email registration branch | `auth login --email <new-email>`, interactive input for Org name | `POST /auth/login`→1007→`POST /auth/register`→poll status; after CONSUMED, credentials persisted to `~/.agenzo-admin-cli/credentials/<org_id>.json`; exit 0 |
| TC-AUTH-LOGIN-02 | Already registered email login | `auth login --email <registered>` | Poll CONSUMED → persist; stdout(json) data=`{org_id,org_name,email,is_new_registration:false}`; exit 0 |
| TC-AUTH-LOGIN-03 | Registration requires invitation code | New email + backend returns 1103 | Interactive prompt `Invitation code:`, retry register after input; success → 0 |
| TC-AUTH-LOGIN-04 | Invalid invitation code | Wrong invitation code (backend 1104) | Error envelope with corresponding code; exit 1 |
| TC-AUTH-LOGIN-05 | Magic-link timeout | Do not click link, wait >10min (or mock shortened) | `AuthError` timeout; `code=AUTH_TIMEOUT`; exit 3 |
| TC-AUTH-LOGIN-06 | Secret redaction | `auth login ... --format json 1>out 2>err` | `out` does not contain `access_token`/`refresh_token`; token only in credential file |
| TC-AUTH-LOGIN-07 | Idempotency key required + forwarding | `auth login --email e --idempotency-key k1 --verbose` | Request header `Idempotency-Key: k1` (POST /auth/login, registration branch uses same key); never auto-gen |
| TC-AUTH-LOGIN-11 | Missing idempotency key (--yes) | `auth login --email e --yes` (no --idempotency-key) | Local interception `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`; exit 1 (no request sent) |
| TC-AUTH-LOGIN-12 | Missing idempotency key (interactive) | `auth login --email e` (not --yes, no --idempotency-key) | Interactive prompt `Idempotency key (unique per write, for safe retry):`; input provided → continues; empty input triggers non-empty validation; exit 0 |
| TC-AUTH-LOGIN-08 | json mode stderr silence | `auth login ... --format json 1>out 2>err` | `Magic link sent` progress line + spinner **do not** appear in stderr (json silent); stdout contains only payload. Compare: table mode stderr should contain `Magic link sent` |
| TC-AUTH-LOGIN-09 | Binary identification | Packet capture | `User-Agent: agenzo-admin-cli/<v>`; login prompt string is `agenzo-admin-cli auth login` |
| TC-AUTH-LOGIN-10 | `--yes` missing email | `auth login --yes` (no --email) | Reports missing parameter `PARAM_*`; exit 1 (required in --yes mode) |

Execution steps:

```bash
# TC-AUTH-LOGIN-02 registered login + redaction + format
agenzo-admin-cli auth login --email "$EMAIL" --format json 1>out.json 2>err.log
echo "exit=$?"
jq . out.json                                  # must be valid JSON
grep -E "access_token|refresh_token" out.json  # must have no matches (redaction)
test -f ~/.agenzo-admin-cli/credentials/*.json # credentials persisted

# TC-AUTH-LOGIN-07 idempotency key
agenzo-admin-cli auth login --email "$EMAIL" --idempotency-key login-key-1 --verbose 2>&1 | grep -i "Idempotency-Key"
```

Expected assertions: `exit=0`; `jq` succeeds; grep redaction has no matches; credential file exists; verbose log shows forwarded `Idempotency-Key`.

---

### 5.2 `auth logout` (W, local, does not accept idem)

Covers: Req 1.2, 4.4; cli-design §2.4.2.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-AUTH-LOGOUT-01 | Normal sign-out | Signed-in state, execute `auth logout` | Best-effort `POST /auth/logout`; deletes `credentials/<active_org>.json`; data=`{signed_out:true}`; exit 0 |
| TC-AUTH-LOGOUT-02 | Not signed in | Clear active_org then execute | Throws `AuthError(Not signed in)`; `code=AUTH_NOT_SIGNED_IN`; exit 3 |
| TC-AUTH-LOGOUT-03 | Server failure silenced | Mock `/auth/logout` 5xx | Network/server error swallowed, local credentials still deleted; exit 0 |
| TC-AUTH-LOGOUT-04 | Rejects idem flag | `auth logout --idempotency-key k` | Commander reports unknown option/rejects; non-0 exit (local write does not accept this flag) |

Execution steps:

```bash
agenzo-admin-cli auth logout --format json; echo "exit=$?"
ls ~/.agenzo-admin-cli/credentials/   # current org credential should be deleted
# TC-AUTH-LOGOUT-04
agenzo-admin-cli auth logout --idempotency-key k 2>&1; echo "exit=$?"  # expect non-0
```

---

### 5.3 `config set-host` (W, pure local, does not accept idem)

Covers: Req 3.1; cli-design §2.4.3.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-CFG-SET-01 | Host matches existing credential | `config set-host https://agent.everonet.com` (credential exists for this host) | Writes `api_host`; auto `setActiveOrg(match)`; data=`{api_host,active_org}`; exit 0 |
| TC-CFG-SET-02 | Host has no matching credential | `config set-host https://agent-test.everonet.com` (no credential) | Writes host; clears `active_org`; stderr hint `Please run login.`; exit 0 |
| TC-CFG-SET-03 | Missing host positional argument | `config set-host` | Missing parameter → `PARAM_*`; exit 1 |
| TC-CFG-SET-04 | No scheme | `config set-host agent.everonet.com` | Validation failure; exit 1; config not written |
| TC-CFG-SET-05 | No API call | Packet capture | This command makes no HTTP requests |
| TC-CFG-SET-06 | Rejects idem flag | `config set-host <h> --idempotency-key k` | Rejected; non-0 |
| TC-CFG-SET-07 | Output deduplication (regression GAPA-049) | `config set-host <h>` (table) | Status lines (✓/ℹ) appear in stderr only once each; stdout contains only payload projection (API Host/Active Org), no status icons |
| TC-CFG-SET-08 | Rejects public HTTP | `config set-host http://example.com` | Validation failure; exit 1; config not written (only `http://localhost` / `http://127.0.0.1` allowed for local development) |

```bash
agenzo-admin-cli config set-host https://agent-test.everonet.com --format json; echo "exit=$?"
jq .api_host ~/.agenzo-admin-cli/config.json   # should be the new host
```

---

### 5.4 `config show` (R, pure local)

Covers: Req 3.3; cli-design §2.4.4.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-CFG-SHOW-01 | Signed in | `config show` | data=`{api_host,api_path,active_org}`; `active_org` is current value; exit 0 |
| TC-CFG-SHOW-02 | Not signed in | Clear active_org then `config show` | `active_org` is `null` (json) / `(none)` (table); exit 0 |
| TC-CFG-SHOW-03 | No API call | Packet capture | No HTTP requests made |
| TC-CFG-SHOW-04 | JSON clean | `config show --format json` piped to `jq .` | Parse succeeds; stdout contains only payload |
| TC-CFG-SHOW-05 | Table projection consistency | Compare json and table | Table does not contain fields absent from json, and vice versa (Req 4.5) |

```bash
agenzo-admin-cli config show --format json | jq .
agenzo-admin-cli config show   # table default
```

---

### 5.5 `config reset-host` (W, pure local)

Covers: Req 3.2; cli-design §2.4.5.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-CFG-RST-01 | Reset with matching credential | Currently on test host, default host credential exists, execute `config reset-host` | Host written back to `https://agent.everonet.com`; switches to matching org; exit 0 |
| TC-CFG-RST-02 | Reset with no match | No default host credential | Host written back to default; clears active_org; prompts login; exit 0 |
| TC-CFG-RST-03 | Equivalent to set-host | Compare `reset-host` and `set-host <default>` behavior | Identical behavior |
| TC-CFG-RST-04 | Rejects idem flag | `config reset-host --idempotency-key k` | Rejected; non-0 |
| TC-CFG-RST-05 | Output deduplication (regression GAPA-049) | `config reset-host` (table) | Same as set-host: status lines in stderr only once each, stdout contains only payload |

```bash
agenzo-admin-cli config reset-host --format json; echo "exit=$?"
jq .api_host ~/.agenzo-admin-cli/config.json   # == https://agent.everonet.com
```

---

### 5.6 `orgs get` (R, `GET /organizations/me`)

Covers: Req 1.3, 7.1, 7.2; cli-design §2.4.6. Note: verb renamed from source code `me` to `get`; HTTP behavior unchanged.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-ORG-GET-01 | Normal query | Signed in, `orgs get` | `GET /organizations/me`; data=`Organization` (id/name/email/status/created_at/updated_at); exit 0 |
| TC-ORG-GET-02 | Bearer expired | Token expired and refresh failed | `code=AUTH_SESSION_EXPIRED`; exit 3 |
| TC-ORG-GET-03 | Command name | `orgs get` (old `orgs me` should not exist) | `orgs me` reports unknown command; `orgs get` works normally |
| TC-ORG-GET-04 | JSON field fidelity | `--format json` | Field names are backend snake_case, matching cli-design §2.4.6 |
| TC-ORG-GET-05 | Transparent refresh | Token within <300s of expiry | Auto `/auth/refresh` then succeeds; exit 0 |

```bash
agenzo-admin-cli orgs get --format json | jq '{id,name,email,status}'
agenzo-admin-cli orgs me 2>&1; echo "exit=$?"   # expect unknown command / non-0
```

---

### 5.7 `orgs update` (W, `POST /organizations/me/update`, [idem])

Covers: Req 4.3, 5.3; cli-design §2.4.7.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-ORG-UPD-01 | Change name only | `orgs update --name "Acme Inc." --idempotency-key k` | Body contains only name; backend returns `Organization` entity; data=`Organization` (latest); syncs local credential org_name; exit 0 |
| TC-ORG-UPD-02 | Change email (requires verification) | `orgs update --email ops@acme.com --idempotency-key k` | Backend does **not** inline-change email, returns magic-link pending-verification payload `{magic_link_token, expires_at}`; CLI renders as `Status: PENDING_EMAIL_VERIFICATION` + token + expiration time, **does not** render as Organization (otherwise fields would all be undefined); stderr hint `Verification email sent to the new address`; exit 0 |
| TC-ORG-UPD-03 | name+email passed together | Both `--name` and `--email` provided | Backend updates name first, but since new email is present → whole request goes through email change branch, returns magic-link payload rather than Organization; CLI renders as PENDING_EMAIL_VERIFICATION (same as TC-02); exit 0 |
| TC-ORG-UPD-04 | Email conflict | Already-taken email | `code=ORG_CONFLICT` (409); exit 1 |
| TC-ORG-UPD-05 | Invalid email/name | Out of bounds/format error | `code=PARAM_INVALID` (422); exit 1 |
| TC-ORG-UPD-06 | Idempotency key required + forwarding | `orgs update --name X --idempotency-key k1` | Request header `Idempotency-Key: k1`; never auto-gen |
| TC-ORG-UPD-07 | Missing idempotency key | `orgs update --name X --yes` (no --idempotency-key) | Local interception `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`; exit 1 (no request sent) |
| TC-ORG-UPD-08 | Response branching assertion | `--email ... --format json` | stdout JSON contains `magic_link_token`, **does not contain** `id`/`status` Organization fields; when only name is changed, the opposite (contains Organization fields, no magic_link_token) |

```bash
agenzo-admin-cli orgs update --name "Acme Inc." --idempotency-key org-upd-1 --format json | jq '{id,name,status}'
echo "exit=$?"
```

---

### 5.8 `orgs list` (R, pure local, host-filtered)

Covers: Req 3.4; cli-design §2.4.8.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-ORG-LIST-01 | Multiple orgs listed | Machine has ≥2 credentials under current host | data=`Array<{org_id,org_name,email,active}>`; current active marked `active:true`/`*`; exit 0 |
| TC-ORG-LIST-02 | Host filtering | Credentials exist for different hosts | Only lists those with `credential.api_host==current host`; cross-environment credentials are filtered out |
| TC-ORG-LIST-03 | No credentials | Clear credentials directory | stderr `No signed-in organizations`; data=`[]`; exit 0 |
| TC-ORG-LIST-04 | No API call | Packet capture | No HTTP requests made |
| TC-ORG-LIST-05 | JSON array | `--format json` piped to `jq 'type'` | Output is `"array"` |

```bash
agenzo-admin-cli orgs list --format json | jq '.[] | {org_id, active}'
```

---

### 5.9 `orgs switch` (W, pure local, cross-environment guard)

Covers: Req 3.5, 3.6; cli-design §2.4.9.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-ORG-SW-01 | Switch to valid org | `orgs switch <signed-in same-host org_id>` | Sets `active_org`; data=`{active_org}`; exit 0 |
| TC-ORG-SW-02 | Target not signed in | `orgs switch <non-existent org>` | Throws error, hint `agenzo-admin-cli auth login`; exit 1 (or corresponding CLIENT code) |
| TC-ORG-SW-03 | Cross-environment rejection | Switch to org with different `api_host` | Rejected (cross-environment error); `active_org` unchanged; exit 1 |
| TC-ORG-SW-04 | No API call | Packet capture | No HTTP requests made |
| TC-ORG-SW-05 | Rejects idem flag | `orgs switch <id> --idempotency-key k` | Rejected; non-0 |

```bash
agenzo-admin-cli orgs switch "$ORG_ID" --format json; echo "exit=$?"
jq .active_org ~/.agenzo-admin-cli/config.json
```

---

### 5.10 `developers create` (W, `POST /developers/create`, [idem])

Covers: Req 4.3, 5.3, 7.1; cli-design §2.4.10.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-DEV-CRT-01 | Normal creation | `developers create --developer-name shopping-bot --developer-email oncall@acme.com` | `POST /developers/create` body=`{name,email}`; data=`Developer`; exit 0; record `$DEV_ID` |
| TC-DEV-CRT-02 | Interactive completion | No fields provided (not --yes) | Interactive prompts for name/email; success 0 |
| TC-DEV-CRT-03 | --yes missing fields | `developers create --yes` (missing name) | Missing parameter `PARAM_*`; exit 1 |
| TC-DEV-CRT-04 | Duplicate name | Same name within Org | `code=ORG_CONFLICT` (409, per design 409→ORG_CONFLICT); exit 1 |
| TC-DEV-CRT-05 | Invalid email | Format error | `code=PARAM_INVALID` (422); exit 1 |
| TC-DEV-CRT-06 | Idempotency key forwarding | `--idempotency-key dev-crt-1` | Header forwarded; same-key retry does not create duplicate (CLI side only verifies header; backend dedup BACK-090 not verified) |
| TC-DEV-CRT-07 | Bearer expired | Token expired | `code=AUTH_SESSION_EXPIRED`; exit 3 |
| TC-DEV-CRT-08 | billing_mode default | No `--billing-mode` passed | body `billing_mode=pay_per_call`; data.billing_mode=`pay_per_call`; output contains `Billing Mode` line; exit 0 |
| TC-DEV-CRT-09 | billing_mode monthly | `--billing-mode monthly_settlement` | body `billing_mode=monthly_settlement`; data echoes consistently; exit 0 |
| TC-DEV-CRT-10 | billing_mode invalid | `--billing-mode weekly` | Local `resolveBillingMode` throws `ValidationError`→`code=PARAM_INVALID`; exit 1 (no request sent) |
| TC-DEV-CRT-11 | billing_mode normalization | `--billing-mode Monthly_Settlement` | Case-normalized to `monthly_settlement`; exit 0 |

> Side-effect note: The backend creates a settlement account (balance=0/USD/active) for the new developer **only when** `billing_mode=monthly_settlement`; `pay_per_call` (default) does **not** create an account. CLI does not directly assert this side-effect; it is indirectly covered by §5.19 `accounts get` (monthly developer has account, pay_per_call developer returns `data:null`).

```bash
agenzo-admin-cli developers create \
  --developer-name shopping-bot --developer-email oncall@acme.com \
  --billing-mode monthly_settlement \
  --idempotency-key dev-crt-1 --format json 1>dev.json 2>err.log
echo "exit=$?"; DEV_ID=$(jq -r '.id // .developer_id' dev.json); echo "$DEV_ID"
jq -r '.billing_mode' dev.json   # == monthly_settlement
# TC-DEV-CRT-10 invalid billing_mode local interception
agenzo-admin-cli developers create --developer-name x --developer-email x@e.com \
  --billing-mode weekly --idempotency-key dev-crt-2 2>&1; echo "exit=$?"   # expect 1
```

---

### 5.11 `developers list` (R, `GET /developers`)

Covers: Req 7.1; cli-design §2.4.11.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-DEV-LST-01 | Has data | `developers list` | data=`Developer[]`; fields id/name/email/status; exit 0 |
| TC-DEV-LST-02 | No data | New Org | stderr `No developers found`; data=`[]`; exit 0 |
| TC-DEV-LST-03 | Bearer expired | Token expired | `AUTH_SESSION_EXPIRED`; exit 3 |
| TC-DEV-LST-04 | JSON array | `--format json` piped to `jq 'type'` | `"array"` |

```bash
agenzo-admin-cli developers list --format json | jq '.[] | {id,name,status}'
```

---

### 5.12 `developers get` (R, `GET /developers/{id}`)

Covers: Req 7.1; cli-design §2.4.12.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-DEV-GET-01 | Normal | `developers get $DEV_ID` | data=`Developer` (includes created_at/updated_at + `billing_mode`); output contains `Billing Mode` line; exit 0 |
| TC-DEV-GET-02 | Not found | `developers get dev_notexist` | 404 noun mapping; exit 1 (note: design matrix 404→1) |
| TC-DEV-GET-03 | Missing positional argument | `developers get` | Missing parameter; exit 1 |

```bash
agenzo-admin-cli developers get "$DEV_ID" --format json | jq '{id,name,status,billing_mode,created_at}'
agenzo-admin-cli developers get dev_notexist 2>&1; echo "exit=$?"   # expect 1
```

---

### 5.13 `developers update` (W, `POST /developers/{id}/update`, [idem])

Covers: Req 4.3, 5.3, 7.1; cli-design §2.4.13.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-DEV-UPD-01 | Change name | `developers update $DEV_ID --name shopping-bot-prod` | data=`Developer` (latest); exit 0 |
| TC-DEV-UPD-02 | Change email | `--email ops@acme.com` | exit 0 |
| TC-DEV-UPD-03 | Not found | Wrong id | 404 → exit 1 |
| TC-DEV-UPD-04 | Duplicate name | 409 | `ORG_CONFLICT`; exit 1 |
| TC-DEV-UPD-05 | Invalid email | 422 | `PARAM_INVALID`; exit 1 |
| TC-DEV-UPD-06 | Idempotency key forwarding | `--idempotency-key dev-upd-1` | Header forwarded |

```bash
agenzo-admin-cli developers update "$DEV_ID" --name shopping-bot-prod \
  --idempotency-key dev-upd-1 --format json | jq '{id,name}'
echo "exit=$?"
```

---

### 5.14 `keys create` (W, `POST /keys/create`, [idem], one-time plaintext)

Covers: Req 4.3, 5.3, 6.2; cli-design §2.4.14.

> Scope status: **backend has implemented** — on create, `scope` is stored in `ap_api_keys.scope`; create/list/get/rotate responses all return scope; omitting `--scope` causes the backend to grant all three; scope is normalized (deduplicated + sorted as `token,merchant,payment`). CLI still retains "backfill request value when response has no scope" as a defensive fallback (only effective against older backends).

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-KEY-CRT-01 | Normal issuance | `keys create --developer-id $DEV_ID --key-name "Production Key" --scope token,merchant,payment` | data=`ApiKey` (includes one-time `api_key` + `scope`); backend persists scope; persisted to `keys.json`; exit 0 |
| TC-KEY-CRT-02 | Default scope | No --scope passed | Backend grants and returns `["token","merchant","payment"]` |
| TC-KEY-CRT-03 | Partial scope | `--scope token` | data.scope=`["token"]` (backend persists this subset) |
| TC-KEY-CRT-04 | Developer not found | Wrong id | 404→`KEY_NOT_FOUND`/`ORG_NOT_FOUND`; exit 1 |
| TC-KEY-CRT-05 | Duplicate name | 409 | `ORG_CONFLICT`; exit 1 |
| TC-KEY-CRT-06 | One-time plaintext + warning | table mode | stderr shows `shown only once` warning; api_key in stdout(json) data |
| TC-KEY-CRT-07 | Bearer redaction | `--format json 1>out` | out does not contain `access_token`/`refresh_token` (api_key is allowed) |
| TC-KEY-CRT-08 | Idempotency key forwarding | `--idempotency-key key-crt-1` | Header forwarded |
| TC-KEY-CRT-09 | Scope out-of-order/duplicate normalization | `--scope payment,token,token` | Backend returns normalized `["token","payment"]` (deduplicated + fixed order) |
| TC-KEY-CRT-10 | Scope invalid value | `--scope token,weekly` | CLI local `parseScopeFlag` throws `ValidationError`→`PARAM_INVALID`; exit 1 (no request sent) |

```bash
agenzo-admin-cli keys create --developer-id "$DEV_ID" --key-name "Production Key" \
  --scope token,merchant,payment --idempotency-key key-crt-1 --format json 1>key.json 2>err.log
echo "exit=$?"
KEY_ID=$(jq -r '.id' key.json); API_KEY=$(jq -r '.api_key' key.json)
grep -E "access_token|refresh_token" key.json   # must have no matches (Bearer redaction)
jq -e '.api_key' key.json                        # api_key must exist
jq -e '.scope == ["token","merchant","payment"]' key.json   # backend returns scope
```

---

### 5.15 `keys list` (R, `GET /keys?developer_id=...`, no plaintext)

Covers: Req 6.3; cli-design §2.4.15.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-KEY-LST-01 | Has data | `keys list --developer-id $DEV_ID` | data=`ApiKey[]`; each item includes `scope`; **no `api_key` field**; Scope column has value; exit 0 |
| TC-KEY-LST-02 | No data | Developer with no keys | stderr `No API Keys found`; data=`[]`; exit 0 |
| TC-KEY-LST-03 | Plaintext redaction | `--format json` | No element has `api_key`; only contains `key_prefix` / `scope` and other metadata |
| TC-KEY-LST-04 | Developer not found | Wrong id | 404 → exit 1 |
| TC-KEY-LST-05 | Legacy key scope fallback | Query a key created before scope was implemented | Backend falls back to `["token","merchant","payment"]` for documents without a `scope` field; Scope column shows all three (fallback default, **not the actual value at creation time**); exit 0 |

```bash
agenzo-admin-cli keys list --developer-id "$DEV_ID" --format json 1>keys.json
jq -e 'all(.[]; has("api_key") | not)' keys.json   # assert no api_key present
jq -e 'all(.[]; .scope | length > 0)' keys.json    # each item scope non-empty (including legacy fallback)
```

---

### 5.16 `keys get` (R, `GET /keys/{id}`, no plaintext)

Covers: Req 6.3; cli-design §2.4.16.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-KEY-GET-01 | Normal | `keys get $KEY_ID` | data=`ApiKey` metadata (includes `scope`, no `api_key`); Scope row has value; exit 0 |
| TC-KEY-GET-02 | Not found | Wrong key_id | 404→`KEY_NOT_FOUND`; exit 1 |
| TC-KEY-GET-03 | Plaintext redaction | `--format json` | No `api_key` field |
| TC-KEY-GET-04 | Legacy key scope fallback | Key created before scope was implemented | Falls back to `["token","merchant","payment"]` (fallback default, not actual value); exit 0 |

```bash
agenzo-admin-cli keys get "$KEY_ID" --format json 1>kget.json
jq -e 'has("api_key") | not' kget.json   # assert no api_key
jq -e '.scope | length > 0' kget.json    # scope non-empty
```

---

### 5.17 `keys rotate` (W, `POST /keys/{id}/rotate`, [idem], new plaintext)

Covers: Req 4.3, 6.2; cli-design §2.4.17.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-KEY-ROT-01 | Normal rotation | `keys rotate $KEY_ID` | data=`ApiKey` (includes **new** `api_key`); KeyStore plaintext overwritten; exit 0 |
| TC-KEY-ROT-02 | Not found | Wrong id | 404 → exit 1 |
| TC-KEY-ROT-03 | Disabled key cannot be rotated | Disable first then rotate | `code=ORG_CONFLICT` (409 state conflict); exit 1 |
| TC-KEY-ROT-04 | New plaintext + warning | table mode | stderr shows `shown only once`; new api_key in stdout(json) |
| TC-KEY-ROT-05 | key_id unchanged | Compare before and after rotate | `id` unchanged, only `api_key` rotated |
| TC-KEY-ROT-06 | Idempotency key required + forwarding | `--idempotency-key key-rot-1` | Header forwarded; never auto-gen |
| TC-KEY-ROT-07 | Missing idempotency key | `keys rotate $KEY_ID` (no --idempotency-key) | Local interception `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`; exit 1 (no request sent) |
| TC-KEY-ROT-08 | Scope preserved | Compare scope before and after rotate | Rotate does not change scope; response returns same `scope` as original key |

```bash
agenzo-admin-cli keys rotate "$KEY_ID" --idempotency-key key-rot-1 --format json 1>rot.json
echo "exit=$?"; jq -e '.api_key' rot.json   # new plaintext exists
jq -r '.id' rot.json                        # == original KEY_ID
```

---

### 5.18 `keys disable` (W, `POST /keys/{id}/disable`, [idem])

Covers: Req 4.3; cli-design §2.4.18.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-KEY-DIS-01 | Normal disable | `keys disable $KEY_ID` | data=`DisableResult` (status=disabled); exit 0 |
| TC-KEY-DIS-02 | Not found | Wrong id | 404→`KEY_NOT_FOUND`; exit 1 |
| TC-KEY-DIS-03 | Repeated disable is idempotent | Disable the same key twice consecutively (with different or same key) | Second call still returns `disabled`; exit 0 (state converges) |
| TC-KEY-DIS-04 | Idempotency key required + forwarding | `--idempotency-key key-dis-1` | Header forwarded |
| TC-KEY-DIS-06 | Missing idempotency key | `keys disable $KEY_ID` (no --idempotency-key) | Local interception `code=PARAM_IDEMPOTENCY_KEY_REQUIRED`; exit 1 (no request sent) |
| TC-KEY-DIS-05 | Disabled key is invalidated | Use that api_key against the runtime API after disable | Runtime API returns key invalidated (cross-CLI verification, optional) |

```bash
agenzo-admin-cli keys disable "$KEY_ID" --idempotency-key key-dis-1 --format json | jq '.status'
echo "exit=$?"
agenzo-admin-cli keys disable "$KEY_ID" --idempotency-key key-dis-2 --format json | jq '.status'   # idempotent: still disabled
```

---

### 5.19 `accounts get` (R, `GET /accounts?developer_id=...`)

Covers: Req 7.1; cli-design §2.4.19. Queries a Developer's monthly settlement account. An account is created by the backend **only when** `billing_mode=monthly_settlement` during developer creation (balance=0/USD/active); `pay_per_call` developers and legacy developers have no account, returning `data:null` + info hint.

| Case | Scenario | Input | Expected |
| --- | --- | --- | --- |
| TC-ACCT-GET-01 | Normal query | `accounts get --developer-id $DEV_ID` | `GET /accounts?developer_id=$DEV_ID`; data=`SettlementAccount` (id/developer_id/balance/currency/status/created_at/updated_at); exit 0 |
| TC-ACCT-GET-02 | Field fidelity | `--format json` | `balance` is integer (smallest currency unit, cents); `currency=USD`; `status` ∈ `active/suspended/closed`; `id` prefixed with `acct_` |
| TC-ACCT-GET-03 | No account (legacy dev) | Query developer without an account | Backend returns `data:null` + message; table mode stderr shows `No settlement account found...`; json mode stdout=`null`; exit 0 |
| TC-ACCT-GET-04 | Developer not found / cross-Org | `accounts get --developer-id dev_notexist` | Backend 404/1201 → exit 1 |
| TC-ACCT-GET-05 | Interactive completion | No `--developer-id` provided (not --yes) | Interactive prompt `Developer ID:`; input provided → queries; exit 0 |
| TC-ACCT-GET-06 | Read-only, no idempotency | `accounts get --developer-id $DEV_ID --idempotency-key k` | Commander rejects unknown option (read-only command does not accept idem flag); non-0 |
| TC-ACCT-GET-07 | JSON clean | `--format json` piped to `jq .` | Parse succeeds; stdout contains only payload; no Bearer token leak |

```bash
# TC-ACCT-GET-01/02 normal query + fields
agenzo-admin-cli accounts get --developer-id "$DEV_ID" --format json 1>acct.json 2>err.log
echo "exit=$?"
jq '{id,developer_id,balance,currency,status}' acct.json
jq -e '.id | startswith("acct_")' acct.json   # account id prefix
jq -e '.balance | type == "number"' acct.json # balance is integer
grep -E "access_token|refresh_token" acct.json # must have no matches (redaction)

# TC-ACCT-GET-04 not found
agenzo-admin-cli accounts get --developer-id dev_notexist 2>&1; echo "exit=$?"   # expect 1
```

Expected assertions: `exit=0`; `jq` succeeds; `id` starts with `acct_`; `balance` is a number; redaction grep has no matches; non-existent developer exits with 1.

---

## 6. Coverage Matrix (Command × Requirements/Properties)

| Command | Primary Cases | Requirements Covered | Properties Covered |
| --- | --- | --- | --- |
| auth login | TC-AUTH-LOGIN-01..10 | 1.2, 2.1, 2.2, 2.5, 4.1, 4.3, 6.1 | P1, P5, P6 |
| auth logout | TC-AUTH-LOGOUT-01..04 | 1.2, 4.4 | — |
| config set-host | TC-CFG-SET-01..08 | 3.1 | — |
| config show | TC-CFG-SHOW-01..05 | 3.3, 4.1, 4.5 | P1 |
| config reset-host | TC-CFG-RST-01..04 | 3.2 | — |
| orgs get | TC-ORG-GET-01..05 | 1.3, 7.1, 7.2 | P7 |
| orgs update | TC-ORG-UPD-01..07 | 4.3, 5.3 | P6 |
| orgs list | TC-ORG-LIST-01..05 | 3.4 | P1 |
| orgs switch | TC-ORG-SW-01..05 | 3.5, 3.6 | — |
| developers create | TC-DEV-CRT-01..11 | 4.3, 5.3, 7.1 | P6, P7 |
| developers list | TC-DEV-LST-01..04 | 7.1 | P1 |
| developers get | TC-DEV-GET-01..03 | 7.1 | P7 |
| developers update | TC-DEV-UPD-01..06 | 4.3, 5.3, 7.1 | P6 |
| keys create | TC-KEY-CRT-01..10 | 4.3, 5.3, 6.2 | P5, P6 |
| keys list | TC-KEY-LST-01..05 | 6.3 | P5 |
| keys get | TC-KEY-GET-01..04 | 6.3 | P5 |
| keys rotate | TC-KEY-ROT-01..08 | 4.3, 6.2 | P5, P6 |
| keys disable | TC-KEY-DIS-01..05 | 4.3 | P6 |
| accounts get | TC-ACCT-GET-01..07 | 7.1 | P1 |
| Cross-cutting (renderer/exit/error) | UT-FMT/RND/EXIT/ERR/PBT | 4.1, 4.2, 5.1, 5.2, 6.1 | P1–P5 |
| Cross-cutting (billing-mode validation) | UT-BILL-01..05 | 5.3 | — |

> Property numbers P1–P7 correspond to design.md "Correctness Properties". Exit code semantics are defined at the top of §5.

## 7. Execution Order and Suggested End-to-End Walkthrough Script

L3 command chain should be executed in dependency order for variable reuse and end-to-end verification:

```text
auth login → orgs get → developers create → keys create
           → accounts get
           → developers list/get/update
           → keys list/get/rotate/disable
           → orgs update/list/switch
           → config show/set-host/reset-host
           → auth logout
```

After each step, immediately run `echo $?` to validate exit codes, and for write commands add an `--idempotency-key` test case to confirm header forwarding.

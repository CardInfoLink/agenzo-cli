# agenzo-merchant-cli Test Design Document

> This document is the test design for `agenzo-merchant-cli`, aligned with the spec (`requirements.md` / `design.md` / `tasks.md`) and `doc/architecture-upgrade/v1/cli-design.md` §4 (command field-level specification) + §8 (error code dictionary).
> Scope = **7-command matrix** (`services` 2 commands + `ride-elife` 5 commands) + 5 cross-cutting consistency constraints (output contract / error mapping / idempotency key / NDJSON watch / verbatim alignment).
> Authoritative order: cli-standard.md > cli-design.md §4 > design.md.
> Repository: `agenzo-cli/apps/merchant-cli` (binary `agenzo-merchant-cli`, package `@agenzo/merchant-cli`), TypeScript + commander@14 + vitest + tsup; all shared utilities imported from `@agenzo/cli-core`.
> This document is the implementation blueprint and coverage checklist for the UT module (tasks 6.2–6.5): each case is annotated with a case number + corresponding requirement / design Property. §8 provides the command × requirement/property coverage matrix, §9 provides the planned automated test file mapping.

---

## 1. Test Objectives and Scope

### 1.1 Objectives

1. Verify that 7 commands' input/output/HTTP behavior is **verbatim consistent** with cli-design §4.4 field-level specification + existing `merchant-cli/src/` implementation (noun `ride-elife`, sub-paths `/ride/quote`, `/ride/book`, `/ride/<id>/status`, `/ride/<id>/cancel`, `/ride/orders`, decimal monetary amounts) (Req 7.1 / Property 7).
2. Verify API Key authentication (`--api-key` → `X-Api-Key` header) is correctly included on all 7 network-connected commands; when omitted, interactively prompted (password prompt).
3. Verify `--format` defaults to `json` (D2, agent-first, intentionally deviating from cli-core's `table` default); in json mode stdout contains only a single valid JSON (business payload + `profile`/`endpoint` envelope), stderr is completely silent; in table mode status lines/spinner go to stderr (Req 5.1 / Property 1).
4. Verify `--idempotency-key` on 2 write commands (`ride-elife book` / `cancel`): `--yes` with missing key → `PARAM_IDEMPOTENCY_KEY_REQUIRED` (exit 1) and **no request sent**; without `--yes` and missing key → interactive prompt; key format `[A-Za-z0-9_-]{1,128}`, sent as `Idempotency-Key` header, **not in body**; CLI never auto-generates (Req 5.3 / Property 3).
5. Verify error code consolidation (external codes ∈ §8 catalog) and exit code mapping (ride/`SERVICE_*`/`BILLING_*`/`ACCOUNT_*`/`PAYMENT_ORDER_*`/`PARAM_*`→1, `KEY_*`→3, `UPSTREAM_/INTERNAL_/RATE_LIMITED`→4, `CLIENT_ABORTED`→5, `UPGRADE_REQUIRED`→2); api-key 401→`KEY_INVALID`, 403→`KEY_SCOPE_DENIED`; ride backend string codes preserved verbatim (`QUOTE_EXPIRED`/`VEHICLE_UNAVAILABLE`/`BILLING_MODE_MISMATCH`/`PAYMENT_ORDER_*`, D3) (Req 5.2/5.4 / Property 4).
6. Verify `ride-elife book` request body **never contains** `payment_method_id`/card info, at most contains optional `payment_order_id` (pay_per_call); funding is determined by the backend based on `billing_mode` (Req 2.2 / Property 5).
7. Verify `ride-elife get --watch` NDJSON polling: each line is independently valid JSON, stops on terminal status set match or timeout, timeout final line `{ watch_status:'timeout', ... }`, watch stream **does not wrap** in profile/endpoint envelope (Req 3.2 / Property 2).
8. Verify merchant-cli has no local `api-client`/`config-manager`/`errors`/`formatter`/`output`/`prompt-engine`/`version` copies; all imported from `@agenzo/cli-core`, and does not import any other app (Req 4.1/4.3 / Property 6).

### 1.2 In Scope

- 7 commands: `services list/get` + `ride-elife quote/book/get(+--watch)/cancel/list-orders`.
- Global flags: `--format` (json/table, **default json**), `--yes`, `--verbose`, `--api-key` (declared at both program level and per-command level).
- API Key authentication model (`--api-key` → `X-Api-Key` header; when omitted `PromptEngine.resolveInput` password prompt).
- Application domain logic (kept in-app, Req 4.4): ride body assembly (coordinate numericization, required field validation, seat count 0–5), NDJSON watch (`watch.ts`), `--help --format json` verb-schema (`verb-schema.ts`), services built-in registry (`registry.ts`), idempotency key resolve/normalization (`idempotency.ts`).
- `CliError.fromApi(result, { auth:'api-key' })` with api-key parameterization (401→`KEY_INVALID`, 403→`KEY_SCOPE_DENIED`) + §8 string code preservation (D3).
- `renderWithContext` (profile/endpoint envelope, BACK-011).

### 1.3 Out of Scope

- admin-cli's auth/config/orgs/developers/keys/accounts commands; token-cli's payment-methods/payment-tokens commands; payment-cli.
- Any host configuration commands (no `config` noun): environment governance belongs to admin-cli (admin's `config set-host` sets it uniformly), merchant-cli shares its config and does not govern the environment.
- `ride-elife track` (D5, pending impl, backend has no location stream endpoint) — `get --watch` for order status polling is retained.
- Backend `/services` discovery endpoint (BACK-063) / top-level `billing` block / `page` cursor (D4, pending impl) — this iteration's `services list/get` reads the built-in `registry.ts`.
- Backend v3 actual idempotency deduplication implementation (only verifies CLI-side `Idempotency-Key` header forwarding).
- Backend ride second phase (payment-order-id reverse lookup / monthly settlement deduction) server-side logic (CLI only forwards optional `--payment-order-id`).
- cli-core internal implementation (`ApiClient`/`exitCodeFor`/`error-catalog` etc.) unit tests — those belong to cli-core's own test suite.

---

## 2. Test Layering Strategy

| Layer | Tool | Network Required | Coverage Target | Priority |
|---|---|---|---|---|
| L1 Unit Tests (pure functions) | vitest | No | `normalizeIdempotencyKey`/`resolveIdempotencyKey`, watch engine `isTerminalStatus`/`statusOf`/`resolveSeconds`/`runWatch`, `need`/`num`/`seatCount`/`positiveInt` body validation, `wantsJsonSchema`/`emitSchema`, registry `findService` | P0 (required) |
| L2 Property-Based Tests (PBT) | vitest + fast-check | No | Idempotency key format `[A-Za-z0-9_-]{1,128}` accept/reject; watch termination invariant + timeout final line invariant for arbitrary status sequences | P0 (required) |
| L3 Command Integration Tests (CLI mock) | vitest + mock `ApiClient` | No | 7 commands happy path + key branches + cross-cutting (output channel purity / idempotency enforcement / error mapping), also provides manually executable steps | P0 (required) |
| L4 Command-Level Smoke + Verbatim Alignment Review (E2E + Diff Review) | Compiled binary `agenzo-merchant-cli` + real v3 host; code review + git diff | Yes (E2E) / No (Diff) | 7 commands end-to-end input/output/exit codes; command noun/verb/flags/path/fields verbatim consistent with cli-design §4.4 | P1 (manual, documented in README) |

> Notes: L1/L2 are the required automated tests for this iteration (tasks 6.5 PBT + 6.2–6.4 contained pure function unit tests). L3 command integration (tasks 6.2–6.4) mocks `ApiClient`, does not mock commander (real `parseAsync`). L4 command-level smoke provided as **manually executable steps** (§6), requires a real merchant-scope key; verbatim alignment review (§7) is a code review comparing against cli-design §4.4.

---

## 3. Test Environment and Prerequisites

### 3.1 Build

```bash
npm install
npm run build -w @agenzo/cli-core      # Must build cli-core first (1.1 types / 1.2 error code changes)
npm run build -w @agenzo/merchant-cli  # tsup outputs dist/index.js, bin = agenzo-merchant-cli
npm run test -w @agenzo/merchant-cli   # vitest run (full; includes PBT, note LongRunningPBT)
agenzo-merchant-cli --version
```

> Key constraint (cli-monorepo-checklist): After modifying cli-core exports, **build cli-core first before** typechecking/testing merchant-cli, otherwise `@agenzo/cli-core` resolves to old dist and throws TS2305.

### 3.2 Backend Environment (for L4 manual testing)

- Testing host: `https://agent-test.everonet.com` (host is set uniformly by admin-cli `config set-host`; merchant-cli shares `~/.agenzo-admin-cli/` default config).
- API path: `/api/v3/agent-pay` (v3 envelope `{ code, message, data }`, cli-core `ApiClient` auto-unwraps).
- Requires a valid **merchant scope** API Key (issued by `agenzo-admin-cli keys create --scope merchant`).

### 3.3 Common Assertion Utilities

- JSON validation: `agenzo-merchant-cli <cmd> --format json | jq .` must parse successfully (stdout is a single valid JSON).
- Exit code validation: `echo $?` immediately after command.
- stdout/stderr separation: `agenzo-merchant-cli <cmd> --format json 1>out.txt 2>err.txt`, assert `out.txt` contains only payload + `profile`/`endpoint`, status lines/spinner all in `err.txt`.
- json mode stderr silence: `err.txt` does not contain any status icons (`✓`/`ℹ`/`⚠`/`✗`) or human-readable status text.
- watch NDJSON validation: `agenzo-merchant-cli ride-elife get --order-id <id> --watch | while read line; do echo "$line" | jq -e . >/dev/null; done` (each line can be independently parsed by `jq`).

### 3.4 Global Flag Conventions

- `--format <json|table>`: **default json** (D2); also reads `AGENZO_FORMAT` (`preAction` hook mirrors resolved format).
- `--api-key <key>`: → `X-Api-Key` header; when omitted, interactive password prompt.
- `--yes`: Disables interactive confirm/prompt (for CI / Agent); write commands with `--yes` and missing idempotency key produce hard error.
- `--verbose`: Verbose logging (→ stderr; unknown errors in table mode append raw dump).

### 3.5 Exit Code Semantics

`0` success · `1` business/parameter (ride/`SERVICE_*`/`BILLING_*`/`ACCOUNT_*`/`PAYMENT_ORDER_*`/`PARAM_*`) · `2` upgrade required (`UPGRADE_REQUIRED`) · `3` auth failure/invalid key (`KEY_*`) · `4` network/5xx (`UPSTREAM_*`/`INTERNAL_*`/`RATE_LIMITED`) · `5` user cancelled (`CLIENT_ABORTED` / SIGINT).

---

## 4. L1 / L2 Unit Tests and Property-Based Tests (Automated / vitest)

> These are the required automated tests for this iteration. Each case is annotated with: case number, corresponding requirement/property, input, expected result. Pure functions are directly imported; no mocks needed.

### 4.1 `normalizeIdempotencyKey` — Idempotency Key Format Validation (Property 3 / Req 5.3)

File: `tests/idempotency.test.ts` (source: `src/idempotency.ts`)

| Case | Input | Expected |
|---|---|---|
| UT-IDEM-01 | `"book-123"` | Returns `"book-123"` (valid, unchanged) |
| UT-IDEM-02 | `"  book-123  "` (leading/trailing whitespace) | Trimmed, returns `"book-123"` |
| UT-IDEM-03 | `"A_b-9"` (all character classes) | Returns `"A_b-9"` |
| UT-IDEM-04 | `""` (empty string) | Throws `CliError('PARAM_INVALID')` (does not match `{1,128}`) |
| UT-IDEM-05 | `"has space"` | Throws `CliError('PARAM_INVALID')` |
| UT-IDEM-06 | `"bad!char"` / `"a@b"` | Throws `CliError('PARAM_INVALID')` |
| UT-IDEM-07 | `"a".repeat(129)` (>128) | Throws `CliError('PARAM_INVALID')` |
| UT-IDEM-08 | `"a".repeat(128)` (boundary) | Returns that string (128 is valid) |
| UT-IDEM-09 | Error message | Contains original value + `IDEMPOTENCY_KEY_RULE` (`Use 1-128 characters from [A-Za-z0-9_-].`); `code==='PARAM_INVALID'` |

### 4.2 `resolveIdempotencyKey` — Write Command Idempotency Key Resolution Branches (Property 3 / Req 5.3)

File: `tests/idempotency.test.ts`

| Case | Input (flagValue, opts) | Expected |
|---|---|---|
| UT-IDEM-10 | flag=`"k1"`, yes=true | Returns `"k1"` (if provided, validates+normalizes regardless of yes) |
| UT-IDEM-11 | flag=`"  k1 "`, yes=false | Returns `"k1"` (normalized) |
| UT-IDEM-12 | flag=`"bad!"`, yes=true | Throws `CliError('PARAM_INVALID')` (intercepted at normalization stage) |
| UT-IDEM-13 | flag=undefined, yes=true, commandPath=`'ride-elife book'` | Throws `IdempotencyKeyRequiredError` (→`PARAM_IDEMPOTENCY_KEY_REQUIRED`); message contains command name + `--idempotency-key`; **does not call** PromptEngine |
| UT-IDEM-14 | flag=undefined, yes=false (mock `PromptEngine.resolveInput` returns `"k2"`) | Prompt text `Idempotency key (unique per write, for safe retry):`; returns `"k2"`; validate returns `IDEMPOTENCY_KEY_RULE` for empty/invalid |
| UT-IDEM-15 | flag=undefined, yes=false, prompt returns invalid value | After secondary validation via `normalizeIdempotencyKey` throws `PARAM_INVALID` (fallback) |

### 4.3 Watch Engine Pure Functions (Property 2 / Req 3.2)

File: `tests/watch.test.ts` (source: `src/ride-elife/watch.ts`)

| Case | Input | Expected |
|---|---|---|
| UT-WATCH-01 | `isTerminalStatus('At destination')` | `true` (terminal status set member) |
| UT-WATCH-02 | `isTerminalStatus('Cancelled')`/`'Rejected'`/`'Customer no show'`/`'Driver no show'` | All `true` |
| UT-WATCH-03 | `isTerminalStatus('On board')`/`'Pending'`/`'Accepted'` | All `false` (in-progress states) |
| UT-WATCH-04 | `isTerminalStatus('at destination')` (lowercase) | `false` (**case-sensitive**, must match server casing verbatim) |
| UT-WATCH-05 | `isTerminalStatus(undefined)`/`null` | `false` (missing status never terminates, continue polling) |
| UT-WATCH-06 | `statusOf({status:'Pending'})` | `'Pending'`; `statusOf({status:123})` → `undefined` (string only) |
| UT-WATCH-07 | `resolveSeconds(undefined, 5)` | `5` (default fallback) |
| UT-WATCH-08 | `resolveSeconds('10', 5)` | `10` |
| UT-WATCH-09 | `resolveSeconds('0', 5)`/`'-3'`/`'abc'` | `5` (non-positive/non-finite falls back to default) |
| UT-WATCH-10 | `TERMINAL_STATUSES` / `DEFAULT_WATCH_INTERVAL_SECONDS` / `DEFAULT_WATCH_TIMEOUT_SECONDS` | Set contains exactly 5 terminal statuses; constants are `5` / `600` respectively |

### 4.4 `runWatch` — NDJSON Polling Engine (fake clock, Property 2 / Req 3.2)

File: `tests/watch.test.ts` (injected `fetchStatus`/`writeLine`/`sleep`/`now`, fake clock)

| Case | Scenario (injected sequence) | Expected |
|---|---|---|
| UT-WATCH-11 | First poll is terminal `['At destination']` | `writeLine` called 1 time (that status line); no timeout line written; returns |
| UT-WATCH-12 | `['Pending','Accepted','At destination']`, interval<timeout | `writeLine` called 3 times (one per line); last is terminal status; no timeout line |
| UT-WATCH-13 | Never terminal `['Pending','Pending',...]`, fake clock makes `now()+interval>=deadline` | Final line is exactly `{ watch_status:'timeout', message, last_status:'Pending' }`; each prior result gets one line |
| UT-WATCH-14 | Never terminal and first poll already exceeds timeout budget | At least 1 status line + timeout final line written; `last_status` takes the last polled status |
| UT-WATCH-15 | `fetchStatus` throws `CliError` | Exception propagates upward (aborts entire stream), not swallowed; already-written lines are not rolled back |
| UT-WATCH-16 | Each `writeLine` record | Serialized via `ndjsonWriteLine` as **single-line compact JSON** + newline (assert no multi-line indentation, line ends with `\n`) |
| UT-WATCH-17 | Timeout line `message` | Contains `${timeoutMs/1000}s` text; `watch_status==='timeout'` literal |

### 4.5 Ride Body Validation Helpers (Req 2.1/2.2/3.1/3.4 / Property 7)

File: `tests/ride-helpers.test.ts` (source: each command's `need`/`num`/`seatCount`/`positiveInt`; recommend exporting or asserting via command-level tests)

| Case | Input | Expected |
|---|---|---|
| UT-BODY-01 | `need(undefined,'pickup-lat')` | Throws `CliError('PARAM_INVALID')`, message `Missing required --pickup-lat.` |
| UT-BODY-02 | `need('v','x')` | Returns `'v'` |
| UT-BODY-03 | `num('37.79','pickup-lat')` | Returns `37.79` (numericized) |
| UT-BODY-04 | `num('abc','pickup-lat')` | Throws `PARAM_INVALID` (`must be a number`) |
| UT-BODY-05 | `num(undefined,'price-amount')` | Throws `PARAM_INVALID` (missing takes precedence over non-numeric) |
| UT-BODY-06 | `seatCount('3','child-seat-count')` | Returns `3` |
| UT-BODY-07 | `seatCount('6',...)`/`'-1'`/`'2.5'` | Throws `PARAM_INVALID` (integer 0–5 out of bounds) |
| UT-BODY-08 | `positiveInt('1','page')` | Returns `'1'` (canonical string) |
| UT-BODY-09 | `positiveInt('0',...)`/`'-2'`/`'1.5'`/`'x'` | Throws `PARAM_INVALID` (positive integer constraint) |

### 4.6 verb-schema `--help --format json` (Req 7.1 / Property 7)

File: `tests/verb-schema.test.ts` (source: `src/verb-schema.ts`)

| Case | Input | Expected |
|---|---|---|
| UT-SCHEMA-01 | `wantsJsonSchema(['node','cli','ride-elife','quote','--help','--format','json'])` | `true` |
| UT-SCHEMA-02 | `wantsJsonSchema([...,'--format=json'])` | `true` (equals-sign form) |
| UT-SCHEMA-03 | `wantsJsonSchema([...,'--help'])` (bare help) | `false` (preserves text help, even though program defaults to json — default is not written into argv) |
| UT-SCHEMA-04 | `wantsJsonSchema([...,'--help','--format','table'])` | `false` |
| UT-SCHEMA-05 | `emitSchema(quoteSchema)` capture stdout | Single pretty JSON; `JSON.parse` round-trip contains `cli/noun/verb/description/flags/response/example` |
| UT-SCHEMA-06 | Each schema field alignment | `quoteSchema.flags['pickup-lat'].required===true`; `bookSchema.flags['idempotency-key'].required===true`, `flags['price-currency'].default==='USD'`; `bookSchema.flags` **has no** `payment-method-id` (Property 5); `rideGetSchema.polling.terminal_statuses` has exactly 5 |
| UT-SCHEMA-07 | `quote`/`list-orders` schema | Does not contain `polling` block; `get` schema contains `polling`; `book`/`cancel` contain `error_recovery.PARAM_IDEMPOTENCY_KEY_REQUIRED` |

### 4.7 Services Registry (Req 1.1/1.2)

File: `tests/services.test.ts` (source: `src/services/registry.ts`)

| Case | Input | Expected |
|---|---|---|
| UT-REG-01 | `findService('ride-elife')` | Returns that capability (service_id/name/category=`ride`/provider=`elife`/cli_noun=`ride-elife`/verbs 5 items/workflow/since/discovery) |
| UT-REG-02 | `findService('nope')` | Returns `undefined` |
| UT-REG-03 | `SERVICE_REGISTRY[0].verbs` | `['quote','book','get','cancel','list-orders']` |

### 4.8 PBT Property-Based Tests (fast-check, Property 2 & 3)

File: `tests/pbt.test.ts`

| Case | Generator | Invariant |
|---|---|---|
| PBT-IDEM-01 | Arbitrary `[A-Za-z0-9_-]` string, length 1–128 (1000 runs) | `normalizeIdempotencyKey(s)===s.trim()` (all accepted) |
| PBT-IDEM-02 | Arbitrary string containing out-of-range characters (space/`!`/`@`/CJK/emoji) or length 0 or >128 | `normalizeIdempotencyKey` must throw `PARAM_INVALID` (all rejected) |
| PBT-IDEM-03 | Arbitrary string + yes=true | `resolveIdempotencyKey(undefined,{yes:true,...})` always throws `IdempotencyKeyRequiredError`, never returns an auto-generated key |
| PBT-WATCH-01 | Arbitrary status sequence (with/without terminal states, random length) + arbitrary interval/timeout (interval>0,timeout>0), fake clock | `runWatch` must terminate (not hang); number of written lines is finite |
| PBT-WATCH-02 | Arbitrary status sequence **without** terminal states + fake clock advancement | Must eventually output `watch_status:'timeout'` final line, and only the final line is a timeout line |
| PBT-WATCH-03 | Arbitrary sequence ending with a terminal status | Stops upon hitting terminal status (no more `fetchStatus`/`writeLine` after terminal); no timeout line |
| PBT-WATCH-04 | Arbitrary written NDJSON lines | Each line passes `JSON.parse` successfully and is a single line (contains no unescaped newlines) |

```typescript
import fc from 'fast-check';
import { normalizeIdempotencyKey } from '../src/idempotency';

it('accepts any [A-Za-z0-9_-]{1,128}', () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    (s) => normalizeIdempotencyKey(s) === s,
  ));
});
```

---

## 5. L3 Command-Level Test Cases (per command)

> Each command gets its own section with a uniform structure: **case table** (positive/negative/boundary, used as mock `ApiClient` integration assertions) + **execution steps** (copy-paste commands, used as L4 manual E2E).
> Mock granularity (tasks 6.2–6.4): mock `ApiClient` (intercept `get`/`post` returning preset `{success,data}` or `{success:false,...}`), **do not** mock commander (real `parseAsync`); use `vi.spyOn(process.stdout/stderr,'write')` to separate the two streams.
> Variable conventions: `$API_KEY` (merchant scope), `$QUOTE_ID` (produced by quote), `$RIDE_ID` (produced by book, = `ride_id`) are produced in prior steps and reused.

### 5.1 `services list` (R, built-in registry, no network, no idem)

Corresponds to: Req 1.1, 1.3, 5.1; cli-design §4.4.1.1.

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-SVC-LST-01 | Normal listing | `services list` | data=`{ services:[ServiceListItem] }`, each item contains `service_id`/`name`/`category`/`provider`/`cli_noun`/`version`/`verbs`/`since`/`discovery`; exit 0 |
| TC-SVC-LST-02 | No network | Packet capture | **No HTTP requests made** (data source is built-in registry, D4) |
| TC-SVC-LST-03 | No idem flag | `services list --idempotency-key k` | Commander rejects unknown option (read-only does not accept idem); non-0 |
| TC-SVC-LST-04 | json envelope | `--format json` piped to `jq .` | Parses successfully; stdout contains `services` + `profile`/`endpoint`; stderr silent |
| TC-SVC-LST-05 | table summary | `--format table` | stdout table header `Service ID/Name/Category/Provider/Version/Verbs` + one row `ride-elife`; status lines (if any) go to stderr |
| TC-SVC-LST-06 | List is concise | json | List item **does not contain** `verb_descriptions`/`workflow` (those are full fields for get) |

```bash
agenzo-merchant-cli services list --format json 1>out.json 2>err.txt
echo "exit=$?"; jq -e '.services | type=="array"' out.json
jq -e '.services[0].service_id=="ride-elife"' out.json
test ! -s err.txt && echo "stderr clean"   # json mode stderr silent
```

### 5.2 `services get <service-id>` (R, built-in registry, no network)

Corresponds to: Req 1.2, 1.3, 5.1; cli-design §4.4.1.2.

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-SVC-GET-01 | Match found | `services get ride-elife` | data=full `ServiceCapability` (contains `verb_descriptions`/`workflow`/`discovery`); exit 0 |
| TC-SVC-GET-02 | No match | `services get nope` | Throws `CliError('SERVICE_NOT_FOUND')` (code_num 4101, exit 1); message suggests `Run "services list"` |
| TC-SVC-GET-03 | Missing positional argument | `services get` | Commander reports missing `<service-id>`; non-0 |
| TC-SVC-GET-04 | table full view | `services get ride-elife --format table` | stdout keyValue contains `Workflow`/`Verb descriptions:` blocks; exit 0 |
| TC-SVC-GET-05 | json envelope | `--format json` | stdout contains capability + `profile`/`endpoint`; stderr silent |

```bash
agenzo-merchant-cli services get ride-elife --format json | jq '{service_id,verbs,workflow}'
agenzo-merchant-cli services get nope 2>&1; echo "exit=$?"   # expect 1 (SERVICE_NOT_FOUND)
```

### 5.3 `ride-elife quote` (R, `POST /ride/quote`, no idem)

Corresponds to: Req 2.1, 5.1, 7.1; cli-design §4.4.1.3 quote schema.

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-QUOTE-01 | Normal quote | All required fields + `--pickup-time now` | `POST /ride/quote` (`X-Api-Key`); body `pickup{lat,lng,name}`/`dropoff{...}`/`pickup_time:'now'`; data=`QuoteResponse` (`vehicle_classes[]`+`meet_and_greet`+`is_airport_transfer`); exit 0 |
| TC-QUOTE-02 | Coordinate numericization | `--pickup-lat 37.79` | body.pickup.lat **=== number** `37.79` (not string) (§4.4.1.3) |
| TC-QUOTE-03 | Epoch pickup-time | `--pickup-time 1735689600` | body.pickup_time === number `1735689600` |
| TC-QUOTE-04 | Missing required field | Missing `--dropoff-name` | Throws `PARAM_INVALID` (`Missing required --dropoff-name.`); **no request sent**; exit 1 |
| TC-QUOTE-05 | Non-numeric coordinate | `--pickup-lat abc` | Throws `PARAM_INVALID` (`must be a number`); exit 1 |
| TC-QUOTE-06 | Optional field conditional assembly | With `--passenger-count 2 --luggage-count 1` | body contains `passenger_count:2`/`luggage_count:1` (numericized); when omitted body has no corresponding keys |
| TC-QUOTE-07 | Monetary amount unit | json | `vehicle_classes[].price.amount` is decimal currency unit (**not cents**), forwarded as-is |
| TC-QUOTE-08 | api-key 401 | post returns 401 | Throws `CliError` (`fromApi(...,{auth:'api-key'})`) code=`KEY_INVALID`; exit 3 |
| TC-QUOTE-09 | json stderr silence | `--format json 1>out 2>err` | `Fetching quotes...` progress line (`notify('loading')`) **does not** appear in stderr; stdout contains only payload+envelope |
| TC-QUOTE-10 | table progress line | `--format table` | stderr contains `Fetching quotes...` status line; stdout is vehicle table + info block |

```bash
agenzo-merchant-cli ride-elife quote --api-key "$API_KEY" \
  --pickup-lat 37.7937 --pickup-lng -122.3956 --pickup-name "1 Market St" \
  --dropoff-lat 37.6213 --dropoff-lng -122.3790 --dropoff-name "SFO Airport" \
  --pickup-time now --format json 1>q.json 2>err.txt
echo "exit=$?"; QUOTE_ID=$(jq -r '.vehicle_classes[0].price.quote_id' q.json); echo "$QUOTE_ID"
```

### 5.4 `ride-elife book` (W/Y, `POST /ride/book`, [idem])

Corresponds to: Req 2.2, 2.3, 2.4, 2.5, 5.1, 5.3, 7.1; cli-design §4.4.1.3 book schema + §4.4.2.1. [Property 5]

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-BOOK-01 | Normal booking (--yes) | `--yes` + required fields + `--idempotency-key k` | `POST /ride/book` (`X-Api-Key` + header `Idempotency-Key:k`); body `quote_id`/`vehicle_class`/`price_amount`(num)/`price_currency`/`passenger_name`/`passenger_phone`; data=`BookResponse`; exit 0; record `$RIDE_ID` |
| TC-BOOK-02 | **No payment_method_id** (Property 5) | Any book call | body **never contains** `payment_method_id` or any card fields; at most contains optional `payment_order_id` |
| TC-BOOK-03 | pay_per_call | `--payment-order-id po_1` | body.payment_order_id===`'po_1'`; when omitted body has no such key (monthly_settlement) |
| TC-BOOK-04 | price-currency default | `--price-currency` not provided | body.price_currency===`'USD'` |
| TC-BOOK-05 | Price numericization | `--price-amount 42.50` | body.price_amount === number `42.5` (decimal, not cents) |
| TC-BOOK-06 | Missing required field | Missing `--passenger-phone` | Throws `PARAM_INVALID`; no request sent; exit 1 |
| TC-BOOK-07 | Seat count out of bounds | `--child-seat-count 6` | Throws `PARAM_INVALID` (integer 0–5); exit 1 |
| TC-BOOK-08 | Pickup conditional assembly | Any `--pickup-{lat/lng/name}` present | body.pickup has all three fields (missing name→`PARAM_INVALID`); all absent then body has no pickup |
| TC-BOOK-09 | Flight info assembly | `--arrival-flight-no AA1 --arrival-airline AA` | body.arrival_flight={flight_no,airline} |
| TC-BOOK-10 | Non --yes confirm | Non `--yes` (mock confirm=true) | Shows `Book ride with quote <id>?` (default true) → after confirmation proceeds to book; exit 0 |
| TC-BOOK-11 | Confirm rejected | Non `--yes` (confirm=false) | Throws `CliError('CLIENT_ABORTED')`; **no request sent**; exit 5 |
| TC-BOOK-12 | --yes missing idempotency key | `--yes` (no `--idempotency-key`) | Throws `PARAM_IDEMPOTENCY_KEY_REQUIRED`; **no request sent**; exit 1 |
| TC-BOOK-13 | Invalid idempotency key | `--idempotency-key "bad!"` | Throws `PARAM_INVALID` (normalization intercepts); no request sent; exit 1 |
| TC-BOOK-14 | Idempotency key as header not in body | `--idempotency-key k` | HTTP header `Idempotency-Key:k`; body **has no** `idempotency_key`/any idempotency field |
| TC-BOOK-15 | Ride string code preservation (D3) | post returns `{code:'QUOTE_EXPIRED'}` HTTP 410 | Via `fromApi` preserves `QUOTE_EXPIRED` (code_num 4202, exit 1), not overridden by 410→PARAM_INVALID |
| TC-BOOK-16 | Billing error | post returns `BILLING_MODE_MISMATCH` | Code preserved (3001, exit 1) |
| TC-BOOK-17 | json stderr silence | `--yes ... --format json 1>out 2>err` | `Booking ride...` not in stderr; stdout contains only `BookResponse`+envelope |

```bash
agenzo-merchant-cli ride-elife book --api-key "$API_KEY" --yes \
  --quote-id "$QUOTE_ID" --vehicle-class Sedan --price-amount 42.50 \
  --passenger-name "Alice" --passenger-phone "+14155551234" \
  --idempotency-key "book-$(date +%s)" --format json 1>b.json 2>err.txt
echo "exit=$?"; RIDE_ID=$(jq -r '.ride_id' b.json); echo "$RIDE_ID"
# TC-BOOK-12 --yes missing idempotency key
agenzo-merchant-cli ride-elife book --api-key "$API_KEY" --yes \
  --quote-id "$QUOTE_ID" --vehicle-class Sedan --price-amount 42.50 \
  --passenger-name A --passenger-phone "+1415" 2>&1; echo "exit=$?"   # expect 1
```

### 5.5 `ride-elife get` (R, `GET /ride/<id>/status`; `--watch` → NDJSON)

Corresponds to: Req 3.1, 3.2, 5.1, 7.1; cli-design §4.4.1.3 get schema. [Property 2]

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-GET-01 | Single query | `get --order-id $RIDE_ID` (no watch) | `GET /ride/<id>/status` (id via `encodeURIComponent`); data=`GetOrderResponse`; `CommandResult`+renderWithContext; exit 0 |
| TC-GET-02 | Field preservation | json | pickup/dropoff are `from_location`/`to_location` (**v3 snake_case**, not elife `from`/`to`); contains `source` marker; amount is decimal |
| TC-GET-03 | Missing order-id | `get` (no `--order-id`) | Throws `PARAM_INVALID`; exit 1 |
| TC-GET-04 | 404 forwarded | get returns `VEHICLE_UNAVAILABLE`/404 | Code preserved/mapped; exit 1 |
| TC-GET-05 | api-key 403 | get returns 403 | code=`KEY_SCOPE_DENIED`; exit 3 |
| TC-GET-06 | watch stops on terminal | `--watch` (mock sequence `Pending`→`At destination`, shortened interval) | stdout 2 lines NDJSON, each line independently parseable by `jq`; last line status=`At destination`; **no** timeout line; exit 0 |
| TC-GET-07 | watch timeout final line | `--watch --watch-timeout` (mock always `Pending`, fake clock) | Final line `{ watch_status:'timeout', message, last_status:'Pending' }`; exit 0 |
| TC-GET-08 | watch does not wrap in envelope | `--watch --format json` | NDJSON lines **do not contain** `profile`/`endpoint` (line stream, per-line); non-watch single query does contain envelope |
| TC-GET-09 | watch no spinner | `--watch` | No `notify('loading')` progress line (the stream itself is the progress); stderr does not contain `Fetching ride status...` |
| TC-GET-10 | watch interval resolution | `--watch-interval 0` (non-positive) | Falls back to default 5s (`resolveSeconds`) |

```bash
agenzo-merchant-cli ride-elife get --api-key "$API_KEY" --order-id "$RIDE_ID" --format json | jq '{ride_id,status,from_location,to_location}'
# watch (each line is independent NDJSON)
agenzo-merchant-cli ride-elife get --api-key "$API_KEY" --order-id "$RIDE_ID" --watch --watch-interval 3 --watch-timeout 30 \
  | while read -r line; do echo "$line" | jq -e . >/dev/null && echo "valid: $(echo "$line" | jq -r '.status // .watch_status')"; done
```

### 5.6 `ride-elife cancel` (W/Y, `POST /ride/<id>/cancel`, no body, [idem])

Corresponds to: Req 3.3, 3.5, 5.1, 5.3, 7.1; cli-design §4.4.1.3 cancel schema.

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-CANCEL-01 | Normal cancellation (--yes) | `--yes --order-id $RIDE_ID --idempotency-key k` | `POST /ride/<id>/cancel` (**no body**, `X-Api-Key` + header `Idempotency-Key:k`); data=`CancelResponse` (`ride_id`/`ride_stat`/`cancellation{fee,reversal,currency}`/`refund_amount`); exit 0 |
| TC-CANCEL-02 | No body assertion | Any cancel | `apiClient.post` 3rd argument body===`undefined`; idempotency key only in 4th argument header |
| TC-CANCEL-03 | Missing order-id | No `--order-id` | Throws `PARAM_INVALID`; exit 1 |
| TC-CANCEL-04 | Non --yes confirm | Non `--yes` (mock confirm=true) | Shows `Cancel ride <id>? This may incur a fee.` (default **false**) → after confirmation proceeds to cancel; exit 0 |
| TC-CANCEL-05 | Confirm rejected | Non `--yes` (confirm=false) | Throws `CliError('CLIENT_ABORTED')`; **no request sent**; exit 5 |
| TC-CANCEL-06 | --yes missing idempotency key | `--yes` (no `--idempotency-key`) | Throws `PARAM_IDEMPOTENCY_KEY_REQUIRED`; no request sent; exit 1 |
| TC-CANCEL-07 | Non-cancellable state | post returns `CANCELLATION_NOT_ALLOWED` | Code preserved (4204, exit 1) |
| TC-CANCEL-08 | Cancellation nullable | Response `cancellation:null` | table does not render fee/reversal rows; json outputs `null` as-is; exit 0 |
| TC-CANCEL-09 | json stderr silence | `--yes ... --format json` | `Cancelling ride...` not in stderr; stdout contains only payload+envelope |

```bash
agenzo-merchant-cli ride-elife cancel --api-key "$API_KEY" --yes \
  --order-id "$RIDE_ID" --idempotency-key "cancel-$(date +%s)" --format json | jq '{ride_id,ride_stat,refund_amount}'
echo "exit=$?"
```

### 5.7 `ride-elife list-orders` (R, `GET /ride/orders`, query forwarded)

Corresponds to: Req 3.4, 5.1, 7.1; cli-design §4.4.1.3 list-orders schema.

| Case | Scenario | Input | Expected |
|---|---|---|---|
| TC-LIST-01 | Has data | `list-orders` | `GET /ride/orders` query `page=1&page_size=20` (defaults); data=`ListOrdersResponse` (`orders[]`/`total`/`page`/`page_size`); exit 0 |
| TC-LIST-02 | Default pagination | page/page-size not provided | query contains `page:'1'`/`page_size:'20'` |
| TC-LIST-03 | Filter forwarded | `--status Pending --order-type airport` | query contains `status:'Pending'`/`order_type:'airport'`; when omitted query has no corresponding keys |
| TC-LIST-04 | Invalid pagination | `--page 0` / `--page-size -1` / `--page x` | Throws `PARAM_INVALID` (positive integer); no request sent; exit 1 |
| TC-LIST-05 | Empty list | Response `orders:[]` | table displays `No ride orders found` (stderr info line/stdout per implementation); json `orders:[]`; exit 0 |
| TC-LIST-06 | Monetary amount unit | json | `orders[].price_amount` decimal (not cents) |
| TC-LIST-07 | json envelope | `--format json` | stdout contains `orders`/`total`/`page`/`page_size` + `profile`/`endpoint`; stderr silent |

```bash
agenzo-merchant-cli ride-elife list-orders --api-key "$API_KEY" --status Pending --page 1 --page-size 10 --format json \
  | jq '{total,page,page_size,count:(.orders|length)}'
echo "exit=$?"
```

---

## 6. Cross-Cutting Consistency Assertions (across all commands)

> These are the test-layer manifestation of the design "Correctness Properties" verification items, covered across §4/§5 cases; this section consolidates the invariants as the contract for task 6.4 cross-cutting tests (`tests/cross-cutting.test.ts` or merged into individual command tests).

### 6.1 Output Channel Purity (Property 1 / Req 5.1)

File: `tests/cross-cutting.test.ts`

| Case | Input | Expected |
|---|---|---|
| TC-CHAN-01 | `notify('json','loading','x')` | Does not write to stderr (spy called 0 times) |
| TC-CHAN-02 | `notify('table','loading','x')` | Writes to stderr 1 time (status/spinner text) |
| TC-CHAN-03 | Any network command `--format json` actual run (mock success) | stdout is single valid JSON containing `profile`+`endpoint`; stderr does not contain `✓`/`ℹ`/`⚠`/`✗` or progress text |
| TC-CHAN-04 | Same command `--format table` | stdout is business output (keyValue/table); stderr contains progress/status lines |
| TC-CHAN-05 | watch (`--watch --format json`) | stdout is only NDJSON lines (no envelope); non-watch commands do wrap in `profile`/`endpoint` |
| TC-CHAN-06 | Default format: `--format` not provided (no `AGENZO_FORMAT` set) | Resolves to `json` (D2, program default value) |

### 6.2 Idempotency Key Enforcement (Property 3 / Req 5.3)

File: `tests/cross-cutting.test.ts` (for `book`/`cancel`)

| Case | Command | Input | Expected |
|---|---|---|---|
| TC-IDEM-REQ-01 | `ride-elife book` | `--yes` without `--idempotency-key` | Throws `IdempotencyKeyRequiredError` (`PARAM_IDEMPOTENCY_KEY_REQUIRED`); `apiClient.post` not called; exit 1 |
| TC-IDEM-REQ-02 | `ride-elife cancel` | `--yes` without `--idempotency-key` | Same as above |
| TC-IDEM-REQ-03 | `book` / `cancel` | Valid key provided | Header `Idempotency-Key:<value>`; body has no idempotency field; CLI does not auto-generate |
| TC-IDEM-REQ-04 | Read-only commands | `quote`/`get`/`list-orders`/`services *` | Do not declare `--idempotency-key` (commander rejects that flag) |
| TC-IDEM-REQ-05 | Key format | Invalid/out-of-range key | `normalizeIdempotencyKey` throws `PARAM_INVALID` (consistent with §4.1/PBT-IDEM-02) |

### 6.3 Error Code Consolidation + Exit Codes (Property 4 / Req 5.2, 5.4)

File: `tests/cross-cutting.test.ts`

| Case | Input | Expected code | Expected exitCode |
|---|---|---|---|
| TC-ERR-01 | `fromApi({statusCode:401},{auth:'api-key'})` | `KEY_INVALID` | 3 |
| TC-ERR-02 | `fromApi({statusCode:403},{auth:'api-key'})` | `KEY_SCOPE_DENIED` | 3 |
| TC-ERR-03 | `fromApi({code:'QUOTE_EXPIRED',statusCode:410})` | `QUOTE_EXPIRED` (string code takes priority, D3; code_num 4202) | 1 |
| TC-ERR-04 | `fromApi({code:'VEHICLE_UNAVAILABLE',statusCode:404})` | `VEHICLE_UNAVAILABLE` (4201) | 1 |
| TC-ERR-05 | `fromApi({code:'BILLING_MODE_MISMATCH'})` | `BILLING_MODE_MISMATCH` (3001) | 1 |
| TC-ERR-06 | `fromApi({code:'PAYMENT_ORDER_NOT_PAID'})` | `PAYMENT_ORDER_NOT_PAID` (3202) | 1 |
| TC-ERR-07 | `fromApi({code:'ACCOUNT_INSUFFICIENT_BALANCE'})` | `ACCOUNT_INSUFFICIENT_BALANCE` (3103) | 1 |
| TC-ERR-08 | `CliError('SERVICE_NOT_FOUND')` | `SERVICE_NOT_FOUND` (4101) | 1 |
| TC-ERR-09 | `CliError('PARAM_INVALID')` / `PARAM_IDEMPOTENCY_KEY_REQUIRED` | Same as input (2xxx) | 1 |
| TC-ERR-10 | `fromApi({statusCode:429})` | `RATE_LIMITED` (5001) | 4 |
| TC-ERR-11 | `fromApi({statusCode:500})` / `NetworkError` | `INTERNAL_ERROR`/`UPSTREAM_ERROR` | 4 |
| TC-ERR-12 | `UserCancelError` (SIGINT / confirm rejected) | `CLIENT_ABORTED` | 5 |
| TC-ERR-13 | `UpgradeRequiredError` | `UPGRADE_REQUIRED` | 2 |
| TC-ERR-14 | Any failure `--format json` | stderr contains only `{ error:{ code, code_num, message, request_id? } }` (§8.2); stdout is empty (no partial payload) | Per matrix |
| TC-ERR-15 | Same failure `--format table` | stderr `✗ [<code_num>] <message>`; `request_id` present only for HTTP-origin errors | Per matrix |

> External codes are always ∈ cli-core `error-catalog`; exit codes are always mapped by `exitCodeFor` (consistent with §1.1.5 / §3.5). The premise for D3 string code preservation (whether v3 ride error responses carry a string `error.code`) requires confirmation via §7 E2E curl testing.

### 6.4 Reuse cli-core (No Duplicate Implementation, Property 6 / Req 4.1, 4.3)

File: `tests/cross-cutting.test.ts` (static/structural assertions)

| Case | Assertion |
|---|---|
| TC-CORE-01 | `src/` **does not contain** `core/` (no local api-client/config-manager/errors/formatter/output/prompt-engine/version copies); all such symbols are imported from `@agenzo/cli-core` |
| TC-CORE-02 | `src/**` has no `import ... from '../admin-cli'`/`token-cli`/`payment-cli` (does not import any other app) |
| TC-CORE-03 | Ride/service response types (`QuoteResponse`/`BookResponse`/...) are imported from `@agenzo/cli-core`; app does not re-define them |
| TC-CORE-04 | Merchant domain modules (`watch.ts`/`verb-schema.ts`/`services/registry.ts`/`idempotency.ts` resolve/normalize) remain in-app (not pushed down to cli-core) |

---

## 7. L4 Command-Level Smoke (E2E, manually executable) + Verbatim Alignment Review (Diff Review)

### 7.1 E2E Execution Order (recommended single pass)

Requires a real merchant-scope key (`$API_KEY`). Execute in business dependency order, `echo $?` after each step to verify exit code:

```text
services list → services get ride-elife
  → ride-elife quote (produces $QUOTE_ID)
  → ride-elife book --yes --idempotency-key … (produces $RIDE_ID)
  → ride-elife get --order-id $RIDE_ID
  → ride-elife get --order-id $RIDE_ID --watch (observe NDJSON / terminal status / timeout final line)
  → ride-elife list-orders
  → ride-elife cancel --order-id $RIDE_ID --yes --idempotency-key …
```

For each write command, add one case for "`--yes` missing `--idempotency-key`" to confirm local interception (exit 1, no request sent), and one `--format table` case to confirm status lines go to stderr.

### 7.2 curl Confirmation for D3 (Error Code Preservation Prerequisite)

```bash
# Trigger a ride business error (e.g., expired quote then book), confirm whether v3 error response carries string error.code
curl -s -X POST "$HOST/api/v3/agent-pay/ride/book" -H "X-Api-Key: $API_KEY" \
  -H 'Content-Type: application/json' -d '{"quote_id":"expired",...}' | jq '.code, .message, .data'
```

- If response carries string code (e.g., `QUOTE_EXPIRED`) → CLI `fromApi` preserves it verbatim, test TC-ERR-03/TC-BOOK-15 pass directly.
- If only numeric code / HTTP status is returned → ride-specific code preservation requires backend to add `error.code` (§7.7.3 BACK-021); CLI-side temporarily falls back to HTTP-status mapping.

### 7.3 Verbatim Alignment Review Checklist (Diff Review, Property 7 / Req 7.1)

Code review item-by-item verification (comparing against cli-design §4.4 + existing `merchant-cli/src/`):

| Review Item | Assertion |
|---|---|
| DIFF-01 | Noun name is `ride-elife` (not `ride`); services group is `services` |
| DIFF-02 | HTTP method+path: quote=`POST /ride/quote`, book=`POST /ride/book`, get=`GET /ride/<id>/status`, cancel=`POST /ride/<id>/cancel` (no body), list-orders=`GET /ride/orders`; base `/api/v3/agent-pay` |
| DIFF-03 | Authentication is all `X-Api-Key` (`{type:'api-key'}`); no Bearer/keystore |
| DIFF-04 | Amounts are decimal currency units (not cents) — quote/book/get/list-orders/cancel full chain |
| DIFF-05 | get fields `from_location`/`to_location` (v3 snake_case, not elife `from`/`to`) + `source` marker |
| DIFF-06 | book body has no `payment_method_id`/card fields, at most optional `payment_order_id` (Property 5) |
| DIFF-07 | watch terminal status set has 5 entries (case-sensitive); default interval 5s / timeout 600s; timeout final line `watch_status:'timeout'`; NDJSON does not wrap in envelope |
| DIFF-08 | book/cancel full flag sets are consistent with verb-schema; `--idempotency-key` is forwarded as header not in body |
| DIFF-09 | services list field subset / get full (contains `verb_descriptions`/`workflow`/`discovery`); not found → `SERVICE_NOT_FOUND` |
| DIFF-10 | Success path stdout text/fields are equivalent to existing implementation (migration does not change success path output; only error path unified to use cli-core envelope) |

---

## 8. Coverage Matrix (Command × Requirement/Property)

| Command | Primary Cases | Requirements Covered | Properties Covered |
|---|---|---|---|
| services list | TC-SVC-LST-01..06 | 1.1, 1.3, 5.1 | P1 |
| services get | TC-SVC-GET-01..05 | 1.2, 1.3, 5.1 | P1, P4 |
| ride-elife quote | TC-QUOTE-01..10 | 2.1, 5.1, 7.1 | P1, P4, P7 |
| ride-elife book | TC-BOOK-01..17 | 2.2, 2.3, 2.4, 2.5, 5.1, 5.3, 7.1 | P1, P3, P4, P5, P7 |
| ride-elife get (+watch) | TC-GET-01..10 | 3.1, 3.2, 5.1, 7.1 | P1, P2, P4, P7 |
| ride-elife cancel | TC-CANCEL-01..09 | 3.3, 3.5, 5.1, 5.3, 7.1 | P1, P3, P4, P7 |
| ride-elife list-orders | TC-LIST-01..07 | 3.4, 5.1, 7.1 | P1, P4, P7 |
| Cross-cutting (output channel) | TC-CHAN-01..06 | 5.1 | P1 |
| Cross-cutting (idempotency enforcement) | TC-IDEM-REQ-01..05, UT-IDEM-01..15, PBT-IDEM-01..03 | 5.3 | P3 |
| Cross-cutting (error/exit codes) | TC-ERR-01..15 | 5.2, 5.4 | P4 |
| Cross-cutting (reuse cli-core) | TC-CORE-01..04 | 4.1, 4.3 | P6 |
| Watch engine | UT-WATCH-01..17, PBT-WATCH-01..04 | 3.2 | P2 |
| verb-schema/help | UT-SCHEMA-01..07 | 7.1 | P5*, P7 |
| Body validation helpers | UT-BODY-01..09 | 2.1, 2.2, 3.1, 3.4 | P7 |

> Property numbers P1–P7 correspond to design.md "Correctness Properties". Exit code semantics are in §3.5. `P5*`: verb-schema's `book` flags having no `payment-method-id` indirectly supports Property 5.

---

## 9. Planned Automated Test File Mapping (tasks 6.2–6.5)

| Test File | Cases/Properties Covered | Corresponding Task |
|---|---|---|
| `tests/helpers.ts` | Mock `ApiClient` (intercepts get/post), captureStdout/captureStderr, buildProgram — shared utilities (aligned with admin/token `tests/helpers.ts`) | 6.2 |
| `tests/services.test.ts` | TC-SVC-LST-01..06, TC-SVC-GET-01..05, UT-REG-01..03; output contract (json stdout purity) | 6.2 |
| `tests/ride-elife.test.ts` | TC-QUOTE/BOOK/GET(non-watch)/CANCEL/LIST happy + key branches; UT-BODY-01..09; book has no `payment_method_id`, confirm, coordinate numericization, field verbatim alignment | 6.3 |
| `tests/cross-cutting.test.ts` | TC-CHAN-01..06, TC-IDEM-REQ-01..05, TC-ERR-01..15, TC-CORE-01..04 (output channel/idempotency enforcement/error mapping/reuse cli-core) | 6.4 |
| `tests/idempotency.test.ts` | UT-IDEM-01..15 | 6.4/6.5 |
| `tests/watch.test.ts` | UT-WATCH-01..17 (including fake clock `runWatch`) | 6.5 |
| `tests/verb-schema.test.ts` | UT-SCHEMA-01..07 | 6.3 |
| `tests/pbt.test.ts` | PBT-IDEM-01..03, PBT-WATCH-01..04 (fast-check) | 6.5 |

> When running PBT, pass `LongRunningPBT` in the `execute-bash` warning field. L3 command integration mocks `ApiClient`, uses real `parseAsync`; L4 E2E (§7) requires a real merchant-scope key, manually reproduced, not included in `vitest run`.

## 10. `hotel-redaug` Command Matrix

> The `hotel-redaug` noun adds **13 thin verbs** over the platform `/hotel/*` endpoints, mirroring the `ride-elife` patterns: per-command `--api-key` → `X-Api-Key`, `--format json` default, `Idempotency-Key` **header** (never body) on write verbs, and NDJSON `--watch` on the status/pay reads. All monetary amounts are **DECIMAL currency units** (e.g. `320.00` = 320.00 yuan), never minor units, always paired with a currency. Booking is a create-then-pay split (`create-order` locks inventory without charging, `pay-order` settles it) supporting both `monthly_settlement` and `pay_per_call` billing modes, chosen server-side (`pay-order` takes only `--order-id`, no merchant-transaction-id flag); there is no combined `book` verb. Order status on the wire is the STRING `order_status` (PROCESSING/CONFIRMED/CANCELLED/COMPLETED) plus an integer `order_status_code` (2/3/4/5) on the provider path. Response types: `src/types/hotel.ts`; verb schemas: `src/verb-schema.ts`; watch engine: `src/hotel-redaug/watch.ts`.

### 10.1 Verb → endpoint map

| Verb | Type | HTTP | Idempotency-Key | --watch |
|---|---|---|---|---|
| `search` | R | `POST /hotel/search` | — | — |
| `find-destination` | R | `POST /hotel/find-destination` | — | — |
| `hotel-filters` | R | `POST /hotel/filters` | — | — |
| `list-cities` | R | `POST /hotel/cities` | — | — |
| `hotel-detail` | R | `POST /hotel/detail` | — | — |
| `quote` | R | `POST /hotel/quote` | — | — |
| `create-order` | W/Y | `POST /hotel/create-order` | header | — |
| `pay-order` | W/Y | `POST /hotel/<id>/pay` | header | ✓ |
| `get` | R | `GET /hotel/<id>/status` | — | ✓ |
| `cancel` | W/Y | `POST /hotel/<id>/cancel` | header | — |
| `checkout` | W/Y | `POST /hotel/<id>/checkout` | header | — |
| `get-checkout` | R | `GET /hotel/checkout/<task_order_code>` | — | ✓ |
| `list-orders` | R | `GET /hotel/orders` | — | — |

### 10.2 `hotel-redaug search` (R, `POST /hotel/search`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HSEARCH-01 | Valid coords + dates | `POST /hotel/search` (`X-Api-Key`); snake_case body `{lat,lng,distance,check_in,check_out,adults,children,room_num,star?,keyword?}` (lat/lng as numbers); data `{hotels[]}`; exit 0 |
| TC-HSEARCH-02 | Neither location branch supplied | `PARAM_INVALID` (exactly-one-branch: `--destination-id` XOR `--lat`/`--lng`); no request; exit 1 |
| TC-HSEARCH-03 | Both location branches supplied | `PARAM_INVALID` (exactly-one-branch); no request; exit 1 |
| TC-HSEARCH-04 | `--lat 91` / `--lng 181` | `PARAM_INVALID` (range −90..90 / −180..180); no request; exit 1 |
| TC-HSEARCH-05 | Bad date / `check-out` ≤ `check-in` | `PARAM_INVALID` (YYYY-MM-DD, strictly after); no request; exit 1 |
| TC-HSEARCH-06 | Empty `hotels` | Rendered as success (exit 0), not an error |
| TC-HSEARCH-07 | `--destination-id` branch | Body `{destination_id,distance,check_in,...}` (no lat/lng); exit 0 |
| TC-HSEARCH-08 | Filter flags forwarded only when supplied | `--price-min`/`--price-max`/`--sort-by`/`--page`/`--page-size` + opaque-code arrays forwarded when present, omitted when absent |
| TC-HSEARCH-09 | 401 / 403 | `KEY_INVALID` (3) / `KEY_SCOPE_DENIED` (3) |

### 10.3 `hotel-redaug quote` (R, `POST /hotel/quote`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HQUOTE-01 | Valid `--hotel-id` + dates | `POST /hotel/quote`; body `{hotel_id,check_in,check_out,adults,children,room_num,nationality}`; renders `rates[]` with `product_token`/`total_price`(decimal)/`price_items[]`; exit 0 |
| TC-HQUOTE-02 | Missing `--hotel-id` | `PARAM_INVALID`; no request; exit 1 |
| TC-HQUOTE-03 | Bad/disordered dates | `PARAM_INVALID`; no request; exit 1 |
| TC-HQUOTE-04 | `NO_AVAILABILITY` from platform | String code preserved (4301, exit 1) |

### 10.4 `hotel-redaug create-order` (W/Y, `POST /hotel/create-order`, [idem])

| Case | Scenario | Expected |
|---|---|---|
| TC-HCREATE-01 | Valid `--yes` + idem key | `POST /hotel/create-order` (`X-Api-Key` + `Idempotency-Key` header); decimal `total_amount` + `price_items`; renders `order_id`/`fc_order_code`/`order_status=AWAITING_PAYMENT`/`rooms[]`; exit 0 |
| TC-HCREATE-02 | Missing a required flag | `PARAM_INVALID`; no request; exit 1 |
| TC-HCREATE-03 | `--price-items` not a valid JSON array of `{sale_date,sale_price,breakfast_num}` | `PARAM_INVALID` (parsePriceItems); no request; exit 1 |
| TC-HCREATE-04 | `--yes` missing `--idempotency-key` | `PARAM_IDEMPOTENCY_KEY_REQUIRED`; no request; exit 1 |
| TC-HCREATE-05 | Invalid idem key `bad!` | `PARAM_INVALID`; no request; exit 1 |
| TC-HCREATE-06 | Idem key location | Sent as `Idempotency-Key` header; never in body |
| TC-HCREATE-07 | Confirm declined (no `--yes`) | `CLIENT_ABORTED`; no request; exit 5 |
| TC-HCREATE-08 | Decimal amounts | `total_amount`/`price_items[].sale_price` forwarded verbatim (no minor-unit conversion) |
| TC-HCREATE-09 | Platform `NAME_FORMAT_INVALID` | String code preserved (exit 1) |
| TC-HCREATE-10 | No charge made | Response carries `order_status=AWAITING_PAYMENT`; no settlement/payment fields |

### 10.5 `hotel-redaug pay-order` (W/Y, `POST /hotel/<id>/pay`, [idem]; `--watch` → NDJSON)

| Case | Scenario | Expected |
|---|---|---|
| TC-HPAY-01 | Order with `monthly_settlement` billing_mode, `--yes` | `POST /hotel/<order_id>/pay` (`X-Api-Key` + `Idempotency-Key` header); body is empty (no request params); renders `settlement_path=monthly_settlement`/`pay_status`/`order_status=PAID`; exit 0 |
| TC-HPAY-02 | Order with `pay_per_call` billing_mode, same command (no extra flag) | body is identical/empty; platform queries EVO for the `order_id`; renders `settlement_path=active_payment`; exit 0 |
| TC-HPAY-03 | `PAYMENT_NOT_COMPLETED` (pay_per_call, EVO not yet confirmed for this order_id) | String code preserved; exit 1; order/payment state unchanged |
| TC-HPAY-04 | `--watch` polling | Retries on `PAYMENT_NOT_COMPLETED` at `--watch-interval`; one NDJSON line per attempt; stops on `PAID` or `--watch-timeout` (final line `{watch_status:'timeout',...}`) |
| TC-HPAY-05 | Missing `--order-id` | `PARAM_INVALID`; no request; exit 1 |
| TC-HPAY-06 | `--yes` missing `--idempotency-key` | `PARAM_IDEMPOTENCY_KEY_REQUIRED`; no request; exit 1 |
| TC-HPAY-07 | Idem key location | Sent as `Idempotency-Key` header; never in body |
| TC-HPAY-08 | Confirm declined (no `--yes`) | `CLIENT_ABORTED`; no request; exit 5 |
| TC-HPAY-09 | `BILLING_MODE_MISMATCH` | String code preserved (exit 1) when the order's `billing_mode` is neither `monthly_settlement` nor `pay_per_call` |
| TC-HPAY-10 | `INVALID_ORDER_STATE` (order not `AWAITING_PAYMENT`) | String code preserved (exit 1); no settlement attempted |

### 10.6 `hotel-redaug get` (R, `GET /hotel/<id>/status`; `--watch` → NDJSON)

| Case | Scenario | Expected |
|---|---|---|
| TC-HGET-01 | Single query | `GET /hotel/<id>/status` (id `encodeURIComponent`); renders `order_status` (string) + `order_status_code` (int) + `hotel_confirm_no`; exit 0 |
| TC-HGET-02 | Missing `--order-id` | `PARAM_INVALID`; no request; exit 1 |
| TC-HGET-03 | `--watch` reaches terminal | NDJSON, one line per poll; stops when `order_status_code ∈ {3,4,5}` (or `order_status ∈ {CONFIRMED,CANCELLED,COMPLETED}`); no timeout line; exit 0 |
| TC-HGET-04 | `--watch` timeout | Final line `{ "watch_status":"timeout", ... }`; exit 0 |
| TC-HGET-05 | `--watch` envelope | NDJSON lines NOT wrapped in profile/endpoint envelope |
| TC-HGET-06 | `HOTEL_ORDER_NOT_FOUND` | String code preserved (4304, exit 1) |

### 10.7 `hotel-redaug cancel` (W/Y, `POST /hotel/<id>/cancel`, [idem])

| Case | Scenario | Expected |
|---|---|---|
| TC-HCANCEL-01 | Valid `--yes` + idem | `POST /hotel/<id>/cancel`; body `{fc_order_code,reason?}`; `Idempotency-Key` header; exit 0 |
| TC-HCANCEL-02 | Missing `--order-id`/`--fc-order-code` | `PARAM_INVALID`; no request; exit 1 |
| TC-HCANCEL-03 | Confirmed shape | Renders `cancellation`/`cancellation_fee`/`refund_amount` |
| TC-HCANCEL-04 | Accepted-but-pending shape | Renders `cancel_status=cancel_pending`; info line: acceptance ≠ proof — poll `get` until CANCELLED (4) |
| TC-HCANCEL-05 | Confirm declined | `CLIENT_ABORTED`; no request; exit 5 |
| TC-HCANCEL-06 | `CANCELLATION_NOT_ALLOWED` / `ALREADY_CANCELLED` | String codes preserved (4204 / 4305, exit 1) |

### 10.8 `hotel-redaug checkout` (W/Y, `POST /hotel/<id>/checkout`, [idem])

| Case | Scenario | Expected |
|---|---|---|
| TC-HCHECKOUT-01 | Valid `--yes` + idem | `POST /hotel/<id>/checkout`; body `{fc_order_code,reason,refund_type,checkout_rooms}`; renders `task_order_code`; async info → poll `get-checkout`; exit 0 |
| TC-HCHECKOUT-02 | Missing required flag | `PARAM_INVALID`; no request; exit 1 |
| TC-HCHECKOUT-03 | `--checkout-rooms` not valid JSON array of `{room_index,guest_name,cancel_check_in_date}` | `PARAM_INVALID` (parseCheckoutRooms); no request; exit 1 |
| TC-HCHECKOUT-04 | Confirm declined | `CLIENT_ABORTED`; no request; exit 5 |
| TC-HCHECKOUT-05 | `CHECKOUT_NOT_ALLOWED` | String code preserved (4306, exit 1) |

### 10.9 `hotel-redaug get-checkout` (R, `GET /hotel/checkout/<task_order_code>`; `--watch`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HGETCO-01 | Single query | `GET /hotel/checkout/<code>` (`encodeURIComponent`); renders `refund_status` + `refund`; exit 0 |
| TC-HGETCO-02 | Missing `--task-order-code` | `PARAM_INVALID`; no request; exit 1 |
| TC-HGETCO-03 | `--watch` terminal | Stops when `refund_status ∈ {approved,rejected,refunded}`; NDJSON, no envelope; exit 0 |
| TC-HGETCO-04 | `--watch` timeout | Final line `{ "watch_status":"timeout", ... }`; exit 0 |
| TC-HGETCO-05 | `CHECKOUT_TASK_NOT_FOUND` | String code preserved (4307, exit 1) |

### 10.10 `hotel-redaug list-orders` (R, `GET /hotel/orders`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HLIST-01 | Defaults | `GET /hotel/orders?page=1&page_size=20`; renders `orders[]`/`total`/`page`/`page_size`; exit 0 |
| TC-HLIST-02 | `--page 0` / `--page-size -1` / non-integer | `PARAM_INVALID` (positive integer); no request; exit 1 |
| TC-HLIST-03 | `--status` omitted | No `status` query param sent (all statuses) |
| TC-HLIST-04 | `--status CONFIRMED` | `status=CONFIRMED` query param present |

### 10.11 `hotel-redaug find-destination` (R, `POST /hotel/find-destination`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HFINDDEST-01 | Valid `--keyword` | `POST /hotel/find-destination` (`X-Api-Key`); body `{keyword, data_type?}`; renders `destinations[]`; exit 0 |
| TC-HFINDDEST-02 | Missing/empty `--keyword` | `PARAM_INVALID` before any request; exit 1 |
| TC-HFINDDEST-03 | `--data-type` optional | When supplied, forwarded as `data_type` in body; when omitted, key absent from body |
| TC-HFINDDEST-04 | Empty `destinations` | Rendered as success (exit 0), not an error |

### 10.12 `hotel-redaug hotel-filters` (R, `POST /hotel/filters`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HFILTERS-01 | `--destination-id` branch | `POST /hotel/filters` (`X-Api-Key`); body `{destination_id, distance}`; renders filter groups (stars/brands/groups/labels/sub_categories/hotel_facilities/room_facilities); exit 0 |
| TC-HFILTERS-02 | `--lat`/`--lng` branch | Body `{lat, lng, distance}`; same render; exit 0 |
| TC-HFILTERS-03 | Both branches supplied | `PARAM_INVALID` (exactly-one-branch); no request; exit 1 |
| TC-HFILTERS-04 | Neither branch supplied | `PARAM_INVALID`; no request; exit 1 |
| TC-HFILTERS-05 | Coord range (`--lat 91` / `--lng 181`) | `PARAM_INVALID`; no request; exit 1 |

### 10.13 `hotel-redaug list-cities` (R, `POST /hotel/cities`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HCITIES-01 | Valid `--country` | `POST /hotel/cities` (`X-Api-Key`); body `{country_code}`; renders `cities[]` with `city_code`/`city_name`/`destination_id`/`lat`/`lng`; exit 0 |
| TC-HCITIES-02 | Missing/empty `--country` | `PARAM_INVALID` before any request; exit 1 |

### 10.14 `hotel-redaug hotel-detail` (R, `POST /hotel/detail`)

| Case | Scenario | Expected |
|---|---|---|
| TC-HDETAIL-01 | Valid `--hotel-id` | `POST /hotel/detail` (`X-Api-Key`); body `{hotel_id, with_images}`; renders detail (`hotel_name`/`star`/`address`/`intro`/`facilities[]`/`images[]`); exit 0 |
| TC-HDETAIL-02 | Missing/empty `--hotel-id` | `PARAM_INVALID` before any request; exit 1 |
| TC-HDETAIL-03 | `--with-images false` | Body `with_images=false`; response `images` is empty array |
| TC-HDETAIL-04 | `--with-images` default true | Body `with_images=true` (default); images rendered when platform returns them |

### 10.15 Cross-cutting (hotel-redaug)

- **Auth:** every verb takes `--api-key` → `X-Api-Key`; HTTP 401 → `KEY_INVALID` (exit 3), 403 → `KEY_SCOPE_DENIED` (exit 3) via `CliError.fromApi(result, { auth:'api-key' })`.
- **Error codes (exit 1) preserved verbatim from the platform string code:** `NO_AVAILABILITY`(4301), `PRICE_CHANGED`(4302), `NAME_FORMAT_INVALID`(4303), `HOTEL_ORDER_NOT_FOUND`(4304), `ALREADY_CANCELLED`(4305), `CHECKOUT_NOT_ALLOWED`(4306), `CHECKOUT_TASK_NOT_FOUND`(4307), `PAY_PER_CALL_NOT_AVAILABLE`(4308), plus reused `BILLING_MODE_MISMATCH`(3001), `ACCOUNT_*`(31xx), `BOOKING_FAILED`(4203), `CANCELLATION_NOT_ALLOWED`(4204).
- **Output contract:** `--format json` default — single JSON (payload + profile/endpoint envelope) on stdout, status/spinner on stderr; `--watch` is a raw NDJSON line stream (no envelope).
- **Idempotency:** `create-order`/`pay-order`/`cancel`/`checkout` require `--idempotency-key` (`[A-Za-z0-9_-]{1,128}`), forwarded as the `Idempotency-Key` header, never auto-generated, never in the body (reuses `src/idempotency.ts`).
- **Amounts:** DECIMAL currency units throughout; never minor units.
- **Scope:** 13 verbs registered, including `find-destination` (search-prep lookup — the platform now exposes `/hotel/find-destination`) and the `create-order`/`pay-order` split (no combined `book` verb).

### 10.16 Planned automated test files (hotel-redaug)

- `tests/hotel-pbt.test.ts` — Properties 1–8, 11, 12 (validation, JSON-flag parsing, request assembly, decimal amounts, billing guard, idempotency, list-orders query, error mapping).
- `tests/hotel-watch.test.ts` — Properties 9–10 (watch terminal predicates + termination/timeout via fake clock).
- `tests/hotel-redaug.test.ts` — per-verb integration (mocked `ApiClient`): body/query assembly, confirm/`--yes`/api-key prompt branches, rendering, error mapping.
- `tests/hotel-verb-schema.test.ts` — `--help --format json` emission, `polling` blocks (`get`/`get-checkout`), flag/response alignment, `error_recovery` keys.
- Registration test — `hotel-redaug` exposes exactly **12 verbs** including `find-destination`, no host/profile subcommand.
- E2E (testing profile) — `search → quote → book → get` against `agent-test.everonet.com` with a merchant-scoped key.

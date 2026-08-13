# token-cli — Payment Methods & Tokens (`agenzo-token-cli`)

`@agenzo/token-cli` — runtime plane: manage payment methods (`payment-methods`) and mint payment tokens (`payment-tokens`). **API Key** auth: every verb takes `--api-key` (the full `sk_<env>_...` string from [admin-cli](admin-cli.md) `keys create`). There is no login/session — the key is passed per command (prompted interactively if omitted).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, idempotency).

## Command matrix

13 commands, all API-Key auth (`--api-key`):

| Noun | Verb | Type | Description |
|---|---|---|---|
| `payment-methods` | `add` | Write | Add a payment method — Evo manual 3DS, Evo Drop-in (`--mode dropin`), or UnionPay enrollment (`--payment-brand unionpay`). Blocks and polls to a terminal status. |
| `payment-methods` | `list` | Read | List payment methods (optionally `--member`) |
| `payment-methods` | `get` | Read | View payment method details |
| `payment-methods` | `disable` | Write | Disable a payment method (revokes its tokens) |
| `payment-methods` | `dropin-create` | Write | Mint a Drop-in session and return `session_id` — **no polling** |
| `payment-methods` | `dropin-status` | Read | Single Drop-in binding status check |
| `payment-methods` | `unionpay-enroll` | Write | Start UnionPay enrollment and return `enroll_url` — **no polling** |
| `payment-methods` | `unionpay-status` | Read | Single UnionPay card-binding status check |
| `payment-tokens` | `create` | Write | Create a token (VCN / Network Token / X402) |
| `payment-tokens` | `list` | Read | List payment tokens (optionally `--type` / `--member`) |
| `payment-tokens` | `get` | Read | View token details (`--reveal` for full VCN) |
| `payment-tokens` | `revoke` | Write | Revoke a token |
| `payment-tokens` | `unionpay-create` | Write | Start a UnionPay network-token checkout and return `checkout_url` — **no polling** |

**Blocking vs non-blocking.** `add` and `create` are the operator-facing verbs: they start the flow *and* poll for the result, so the process must stay alive. The `dropin-*` / `unionpay-*` pairs are the non-blocking split for programmatic callers (e.g. the agent orchestrator): the `-create` / `-enroll` half returns the URL or session id synchronously, and the caller polls the `-status` half (or `payment-tokens get`) on its own cadence.

**Global flags:** `--verbose`, `--yes` (skip confirmations — required for automation), `--format json|table` (or `AGENZO_FORMAT`).

**Verb schema discovery:** `add`, `list`, `get`, `disable`, `payment-tokens create|list|get|revoke` support `--help --format json`, which prints a machine-readable flag/response schema instead of text help. The non-blocking verbs (`dropin-create`, `dropin-status`, `unionpay-enroll`, `unionpay-status`, `unionpay-create`) do not.

**Id arguments:** `payment-methods get`, `payment-tokens get`, `dropin-status`, and `unionpay-status` accept the id as a positional argument *or* as a flag (`--id` for `get`, `--payment-method-id` for the `*-status` verbs), because the orchestrator's CLI gateway can only pass `--flag value` pairs.

## Payment Methods

```bash
# Evo manual 3DS (blocks until ACTIVE / FAILED / 15-min timeout)
agenzo-token-cli payment-methods add --api-key <key> --email user@example.com \
  --card-number 2223001870064586 --expiry 1226 --cvv 935 --idempotency-key idem_001

# Evo Drop-in (blocks up to 30 min; --no-poll to return immediately)
agenzo-token-cli payment-methods add --mode dropin --api-key <key> --email user@example.com

# UnionPay enrollment (blocks up to 60s)
agenzo-token-cli payment-methods add --payment-brand unionpay --member <member_id> \
  --api-key <key> --email user@example.com

agenzo-token-cli payment-methods list --api-key <key> [--member <member_id>]
agenzo-token-cli payment-methods get <pm_id> --api-key <key>
agenzo-token-cli payment-methods disable <pm_id> --api-key <key> --idempotency-key idem_002
```

### add — flags

| Flag | Applies to | Notes |
|---|---|---|
| `--api-key <key>` | all | Reuse the key from admin-cli; do not ask again |
| `--type <type>` | all | Default `card` |
| `--payment-brand <brand>` | all | `evo` (default) or `unionpay` |
| `--mode <mode>` | evo | `manual` (default) or `dropin` |
| `--email <email>` | all | Manual: 3DS verification address. Dropin: session reference. UnionPay: binding email. |
| `--card-number` / `--expiry <mmyy>` / `--cvv` | evo manual | Skip interactive prompts. ⚠️ Values may land in shell history — automation only. |
| `--idempotency-key <key>` | evo manual | Required; prompted if omitted, hard-fails under `--yes`. Not used by dropin/unionpay. |
| `--no-poll` | evo dropin | Mint the session, print it, exit — for front-end-driven flows |
| `--member <id>` | unionpay | **Required** (prompted interactively; hard-fails under `--yes`) |
| `--return-url <url>` | unionpay | Platform-side post-enrollment navigation hint; never sent to UnionPay |

### add — Evo manual 3DS

1. Collects email + card details, POSTs `/payment-methods/create` with the `Idempotency-Key` header.
2. Prints the created PM (PENDING), then polls verification status every **3s for up to 15 minutes**.
3. The user must complete 3DS in a **browser** — keep the process alive for the whole flow (background it for automation; do not close stdin).
4. On ACTIVE the CLI re-fetches and prints brand / first6 / last4. On timeout it prints the `payment-methods get <pm_id>` follow-up hint.
5. Duplicate cards (same first6 + last4) are overwritten, not rejected.

### add `--mode dropin` — Evo Drop-in

The CLI mints a hosted LinkPay session; the cardholder enters their card in the **DropIn SDK** rendered by your own front-end. PAN/CVV never reach the CLI or the backend. Card flags and `--idempotency-key` are unused in this mode.

1. `POST /payment-methods/dropin/create` → prints `Session ID` (full `{ id, session_id, merchant_trans_id, status }` under `--format json`).
2. Your front-end initialises the SDK with that session id.
3. The CLI polls verification status every **5s for up to 30 minutes** unless `--no-poll` was passed.
4. ACTIVE prints brand + last4. `FAILED` / `EXPIRED` / timeout print the `PM ID` and exit non-zero.

Front-end integration (abridged):

```bash
npm install cil-dropin-components
```

```javascript
import DropInSDK from 'cil-dropin-components'

const sdk = new DropInSDK({
  id: '#dropInApp',
  type: 'payment',
  sessionID: '<session_id from CLI output>',
  mode: 'embedded',            // or 'bottomUp' for mobile
  environment: 'HKG_prod',     // 'UAT' for sandbox
  payment_completed: (d) => console.log('added', d.merchantTransID),
  payment_failed: (d) => console.log('failed', d.message),
  payment_cancelled: () => {}, // session stays PENDING; the CLI keeps polling
})
```

The session id is single-use. If it expires (30 min), re-run with the same `--email` — the PENDING record is reused.

### add `--payment-brand unionpay` — UnionPay card enrollment

No card details are entered at the terminal. The user completes binding by authenticating on a UnionPay-hosted page (no OTP, no email link).

1. `POST /payment-methods/create` with `payment_brand=unionpay` + `member_id` (no idempotency key — this is an enrollment, not a charge).
2. The CLI prints `ID`, `Status`, **`Enroll URL`**, `Correlation ID`.
3. **The user must open the Enroll URL in a browser.**
4. The CLI polls `GET /payment-methods/{id}` every **5s for up to 60s**. UnionPay's webhook flips PENDING → ACTIVE; the CLI then prints brand / first6 / last4.
5. On timeout the PM stays PENDING — check later with `payment-methods get <pm_id>` or `unionpay-status <pm_id>`.

`--member <id>` is caller-defined (your own end-user id) and must be **stable**: the same value is reused server-side for token creation, so a mismatch makes UnionPay reject the token request.

### Non-blocking pairs (programmatic callers)

```bash
# Drop-in: mint session, then poll separately
agenzo-token-cli payment-methods dropin-create --api-key <key> --email user@example.com [--member <id>]
agenzo-token-cli payment-methods dropin-status <pm_id> --api-key <key>
# or: --payment-method-id <pm_id>

# UnionPay: get enroll_url, then poll separately
agenzo-token-cli payment-methods unionpay-enroll --api-key <key> --member <id> --email user@example.com [--return-url <url>]
agenzo-token-cli payment-methods unionpay-status <pm_id> --api-key <key>
```

- `dropin-create` — returns `PM ID`, `Session ID`, `Merchant Trans ID`, `Status`. `--member` is optional here and scopes the bound card so it shows up under `list --member <id>`.
- `unionpay-enroll` — returns `ID`, `Status`, `Enroll URL`, `Correlation ID`. `--member` is required.
- Both `*-status` verbs do a **single** status check and exit. Status enum: `PENDING | ACTIVE | FAILED | DISABLED | EXPIRED`. `dropin-status` reads `/payment-methods/verification/status`; `unionpay-status` reads `/payment-methods/{id}`.

### disable

`POST /payment-methods/{id}/disable`. Prints `Status` + `Revoked tokens` — disabling a card revokes the payment tokens issued against it. `--idempotency-key` is required (prompted interactively, hard-fails under `--yes`). Only run this when the user explicitly asks.

## Payment Tokens

```bash
# Interactive
agenzo-token-cli payment-tokens create --api-key <key>

# Automation (--yes): --idempotency-key is REQUIRED, never auto-generated
agenzo-token-cli --yes payment-tokens create --type vcn --api-key <key> \
  --card 4586 --amount 30 --idempotency-key idem_001
agenzo-token-cli --yes payment-tokens create --type network-token --api-key <key> \
  --payment-method-id <pm_id> --idempotency-key idem_002
agenzo-token-cli --yes payment-tokens create --type x402 --api-key <key> --payment-method-id <pm_id> \
  --pay-to 0xABC... --amount 1000000 --nonce abc123 --network base_sepolia \
  --deadline 1777457396 --idempotency-key idem_003

agenzo-token-cli payment-tokens list --api-key <key> [--type vcn] [--member <id>]
agenzo-token-cli payment-tokens get <ptk_id> --api-key <key> [--reveal]
agenzo-token-cli payment-tokens revoke <ptk_id> --api-key <key> --idempotency-key idem_004
```

> **One-time tokens**: payment tokens are single-use — create a new one per transaction.

### create — flags

| Flag | Description | Required for |
|---|---|---|
| `--api-key <key>` | API Key (`sk_<env>_...`) | all |
| `--type <type>` | `vcn` \| `network-token` \| `x402`. No default — interactive selector if omitted. | all |
| `--payment-method-id <id>` | Payment method id (skips card lookup) | UnionPay NT |
| `--card <last4>` | Match an ACTIVE card by its **last 4 digits** | optional |
| `--member <member_id>` | Member id | optional |
| `--amount <amount>` | USD for VCN (0.01–500.00, converted to integer cents); USDC micro-units for X402 | VCN, X402 |
| `--currency <code>` | Omitted → not sent; server default applies | optional |
| `--pay-to` / `--nonce` / `--network` / `--deadline` | X402 recipient, nonce, chain, Unix-seconds deadline | X402 |
| `--external-tx-id <id>` | Sent only when supplied; never auto-generated | optional |
| `--recipient-first-name` / `--recipient-last-name` | Recipient name | UnionPay NT |
| `--recipient-email` / `--recipient-phone` | **One of the two** is required | UnionPay NT |
| `--unionpay-amount <amount>` | Intent amount as a **decimal string**, e.g. `"174.58"` | UnionPay NT |
| `--return-url <url>` | Post-payment navigation hint; not sent to UnionPay | optional (UnionPay NT) |
| `--idempotency-key <key>` | Sent as the `Idempotency-Key` header, never in the body. Prompted if omitted; hard-fails under `--yes`. | all |

**Card resolution priority:** `--payment-method-id` → `--card` (last-4 match against ACTIVE cards) → single ACTIVE card auto-selected → interactive picker. Under `--yes` with multiple ACTIVE cards the CLI refuses (`PARAM_INVALID`) instead of guessing.

### Amount units — the trap

| Field | Unit | Conversion |
|---|---|---|
| `--amount` (VCN) | USD decimal, e.g. `30` / `25.50` | CLI converts to **integer cents** in the request body (`amount: 2550`) |
| `--amount` (X402) | USDC smallest units (1 USD = 1,000,000) | passed through |
| `--unionpay-amount` (UnionPay NT) | **decimal string**, e.g. `"174.58"` | forwarded **verbatim** — never converted to cents |
| VCN `Limit` / `Balance` in responses | integer cents | rendered as USD for display |

Never feed a cents integer into `--unionpay-amount`, and never feed a decimal into the VCN wire `amount` — the two amount fields on the same command use different units.

### Token types & compatibility

| Type | Description | Card requirement |
|---|---|---|
| `vcn` | Virtual card with spend limit | any ACTIVE card, plus `gateway_token` in `evo_data` |
| `network-token` | Cryptogram for card-present payments | issuer/network must support NT (`evo_data.network_token` non-empty) |
| `x402` | On-chain payment signature | any ACTIVE card, plus `gateway_token` |

- Missing `gateway_token` (3DS not properly completed) → `This card does not support VCN/X402. Gateway token is missing.`
- No NT support → `This card does not support Network Token.`
- **VCN feature gate**: `create --type vcn` first calls `GET /features/vcn`. If disabled it fast-fails with `TOKEN_FEATURE_DISABLED` (`code_num` 4001), message `VCN creation is not supported yet. Coming soon.`, exit 1. The block is global, not parameter-dependent — do **not** retry with different parameters; suggest `network-token` or `x402` instead (neither is gated).

### Pre-authorization (Evo)

- **VCN**: freeze = amount + 5% service fee (min 1 cent), shown as concrete dollar values before confirmation.
- **X402**: amount converted from USDC micro-units to USD; 5% service fee.
- **Evo Network Token**: flat fee fetched from `GET /config/network-token-fee` (falls back to $0.50).
- **UnionPay Network Token**: no fee/freeze step — the fee bypass is server-side.
- `--yes` skips the confirmation prompt.

### UnionPay Network Token (async, via Checkout URL)

For `payment_brand=unionpay` cards the cryptogram is not returned immediately — the user must authenticate on a UnionPay-hosted checkout page first.

```bash
# Blocking form: create detects the brand and enters the UnionPay branch
agenzo-token-cli payment-tokens create --type network-token \
  --payment-method-id <unionpay_pm_id> --api-key <key> \
  --unionpay-amount 174.58 --recipient-first-name Ada --recipient-last-name Lovelace \
  --recipient-email ada@example.com --idempotency-key idem_005

# Non-blocking form: returns checkout_url immediately, you poll get
agenzo-token-cli payment-tokens unionpay-create --api-key <key> \
  --payment-method-id <unionpay_pm_id> --unionpay-amount 174.58 \
  --recipient-first-name Ada --recipient-last-name Lovelace \
  --recipient-email ada@example.com --idempotency-key idem_006
agenzo-token-cli payment-tokens get <ptk_id> --api-key <key>
```

- **UnionPay cards must be selected with `--payment-method-id`.** `--card` last-4 matching is rejected (`PARAM_INVALID`) for this brand.
- **Do not pass `--member`**: the member id is already on file from enrollment and drives the UPI consumer identity. If supplied it is forwarded verbatim and the server rejects a mismatch. `create` does not prompt for it in this branch.
- The initial response is flat and `PENDING`: `Payment Token ID`, `Type`, `Status`, **`Checkout URL`**, `Correlation ID` — no cryptogram yet.
- **The user must open the Checkout URL in a browser** and complete the UnionPay authentication.
- `create` then polls `GET /payment-tokens/{id}` every **5s for up to 60s**; `unionpay-create` exits immediately and you poll `payment-tokens get` yourself.
- On ACTIVE the token renders `Token Number` (`value`), `Cryptogram`, `Expiry`, `Brand`, and `ECI` when present. On timeout the token stays PENDING — re-open the Checkout URL if it has not expired, or poll `get` later.

**Payment fields:** `Token Number` (send as the card number to the acquirer), `Cryptogram` (one-time credential, required for verification), `Expiry` (MMYY). `ECI` is optional and may be absent in UPI mode.

### get / list / revoke

- `get` masks VCN PAN and CVC by default; `--reveal` prints them in full — only use it when a payment flow actually needs the credential.
- `list` renders a per-type summary: VCN `first6****last4 $limit`, network token → brand, X402 → `amount network`.
- `revoke` has two terminal shapes: immediate (`Status` + `Revoked At`) or **delayed** for X402, where the status stays `ACTIVE` with an `Expires At` — the cryptogram auto-expires instead of being torn down.

## Token-specific errors

| Error | Cause | Fix |
|---|---|---|
| `CLIENT_NO_PAYMENT_METHOD` | No ACTIVE card for this API key | Add one: `payment-methods add` (or `--mode dropin`) |
| `CLIENT_CARD_NOT_MATCHED` | `--card` last-4 matched no ACTIVE card | Run `payment-methods list` and pick a real one |
| `TOKEN_FEATURE_DISABLED` | VCN is switched off server-side | Use `network-token` or `x402`; do not retry VCN |
| `PARAM_IDEMPOTENCY_KEY_REQUIRED` | `--yes` without `--idempotency-key` | Supply a unique key (1–128 chars, `[A-Za-z0-9_-]`) |
| `PARAM_INVALID` | Bad `--payment-brand` / `--mode`, missing `--member`, UnionPay selected via `--card`, ambiguous card under `--yes` | Fix the flag named in the message |
| `This card does not support Network Token` | Issuer does not support NT | Use a card that does |
| `Evo preauth failed` | PSP or issuer rejected preauth | Try another card or retry later |

# token-cli — Payment Methods & Tokens (`agenzo-token-cli`)

`@agenzo/token-cli` — runtime plane: manage payment methods (`payment-methods`) and mint payment tokens (`payment-tokens`). **API Key** auth: every verb takes `--api-key` (the full `sk_<env>_...` string from [admin-cli](admin-cli.md) `keys create`). There is no login/session — the key is passed per command (prompted interactively if omitted).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, idempotency).

## Command matrix

13 commands, all API-Key auth (`--api-key`):

| Noun | Verb | Type | Description |
|---|---|---|---|
| `payment-methods` | `add` | Write | Add a payment method. `--payment-brand visa`, `mastercard`, or omitted all open the **same hosted binding page** (identical `link_url`) — the CLI never collects card details; the page detects the card brand and runs the matching rail (Visa self-mint+passkey / Mastercard EVO). `--payment-brand unionpay` for UnionPay enrollment (separate flow). Blocks and polls to a terminal status. |
| `payment-methods` | `list` | Read | List payment methods (optionally `--member`) |
| `payment-methods` | `get` | Read | View payment method details |
| `payment-methods` | `disable` | Write | Disable a payment method (revokes its tokens) |
| `payment-methods` | `dropin-create` | Write | Mint a Drop-in session and return `session_id` — **no polling** |
| `payment-methods` | `dropin-status` | Read | Single Drop-in verification status check |
| `payment-methods` | `unionpay-enroll` | Write | Start UnionPay enrollment and return `enroll_url` — **no polling** |
| `payment-methods` | `unionpay-status` | Read | Single UnionPay enrollment status check |
| `payment-tokens` | `create` | Write | Create a token (VCN / Network Token / X402) |
| `payment-tokens` | `list` | Read | List payment tokens (optionally `--type` / `--member`) |
| `payment-tokens` | `get` | Read | View token details (`--reveal` for full VCN) |
| `payment-tokens` | `revoke` | Write | Revoke a token |
| `payment-tokens` | `unionpay-create` | Write | Start a UnionPay network-token checkout and return `checkout_url` — **no polling** |
| `payment-tokens` | `visa-create` | Write | Mint a Visa network token: print `payment_url`, then **poll** GET `payment-tokens/{id}` up to 180s until ACTIVE/FAILED — or return right after the URL with `--no-poll` |

**Blocking vs non-blocking.** `add` and `create` are the operator-facing verbs: they start the flow *and* poll for the result, so the process must stay alive. The `dropin-*` / `unionpay-*` pairs are the non-blocking split for programmatic callers (e.g. the agent orchestrator): the `-create` / `-enroll` half returns the URL or session id synchronously, and the caller polls the `-status` half (or `payment-tokens get`) on its own cadence.

**Global flags:** `--verbose`, `--yes` (skip confirmations — required for automation), `--format json|table` (or `AGENZO_FORMAT`).

**Verb schema discovery:** `add`, `list`, `get`, `disable`, `payment-tokens create|list|get|revoke` support `--help --format json`, which prints a machine-readable flag/response schema instead of text help. The non-blocking verbs (`dropin-create`, `dropin-status`, `unionpay-enroll`, `unionpay-status`, `unionpay-create`) do not.

**Id arguments:** `payment-methods get`, `payment-tokens get`, `dropin-status`, and `unionpay-status` accept the id as a positional argument *or* as a flag (`--id` for `get`, `--payment-method-id` for the `*-status` verbs), because the orchestrator's CLI gateway can only pass `--flag value` pairs.

## Payment Methods

```bash
# Hosted binding (default): the CLI opens a binding session, prints link_url,
# and blocks polling up to 30 min. The cardholder opens link_url in a browser,
# enters the card, and the page runs the matching rail (Visa self-mint + passkey,
# or Mastercard/others via EVO Drop-in) — the CLI never touches the card.
agenzo-token-cli payment-methods add --api-key <key> --email user@example.com

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
| `--payment-brand <brand>` | all | Omit (default) for the hosted binding page (supports Visa + Mastercard); `unionpay` for UnionPay enrollment. `evo` / `visa` are gone — the page splits by card brand. |
| `--email <email>` | all | The address the hosted binding link is emailed to (and the UnionPay enrollment email). **Not** a card credential: it is a session reference / cardholder identity, never used to authenticate the card to Visa or Mastercard. |
| `--member <id>` | all | End-user this card belongs to. Optional at the CLI boundary (server decides if mandatory per brand — UnionPay requires it). Omitting stores a developer-scoped card. |
| `--no-poll` | hosted binding | Print `{ id, link_url }` and exit immediately instead of waiting for the cardholder. For programmatic callers (agent orchestrator / CI) that render the link and poll on their own cadence via `dropin-status` / `get`. Default polls to a terminal status. |
| `--hosted-page <target>` | hosted binding | Which card-entry page `link_url` points at. Omit (default) for the **front-end app** page — unchanged behaviour. Pass `platform` for the **platform-hosted** page: use it when no front-end is deployed (headless / orchestrator). Both pages split Visa vs Mastercard by BIN internally. |
| `--return-url <url>` | unionpay | Platform-side post-enrollment navigation hint; never sent to UnionPay |

### add (default) — hosted binding

The CLI never collects card details. It opens a hosted binding session and hands
the cardholder a link; the card is entered and verified **in the browser**, and
the hosted page itself detects the card brand and runs the matching rail — Visa
(VTS self-mint + Payment Passkey) or Mastercard/others (EVO Drop-in) — with both
landing on the same PM. This mirrors the H5 flow: one card-entry surface, brand
split inside the page. `--mode`, `--card-number`, `--cvv`, `--expiry`,
`--client-reference-id`, `--idempotency-key`, and `--payment-brand evo|visa` no
longer exist on this path.

1. `POST /payment-methods/binding-session` with `{ email, member_id? }` → prints
   `ID` (PENDING), `Status`, and **`Link URL`** (the hosted page). The link is
   also emailed to `--email`. With `--hosted-page platform` the body also carries
   `hosted_page` so `link_url` points at the platform-hosted page instead of the
   front-end one (for callers with no front-end deployed).
2. The cardholder opens the Link URL in a browser, enters the card, and completes
   verification (passkey for Visa, 3DS for Mastercard via EVO Drop-in).
3. The CLI polls `GET /payment-methods/verification/status` every **5s for up to
   30 minutes**. Both rails write their result onto the same PM, so this single
   poll converges regardless of which card brand was entered.
4. On ACTIVE the CLI prints brand / first6 / last4. `FAILED` / `EXPIRED` / a
   30-minute timeout print the `PM ID` and exit non-zero — re-run with the same
   `--email`; the PENDING record is reused.

Steps 3–4 are skipped with `--no-poll`: the CLI stops after step 1 so a
programmatic caller gets `link_url` **synchronously** and polls on its own cadence.
That matters for hosts that read the CLI's stdout only after the process exits (the
agent orchestrator does), where the default 30-minute block would time out before
`link_url` was ever readable.

The card number, CVV and expiry never reach the CLI, the calling system, or the
CLI's argv — only the hosted page (and, downstream, the acquirer/VTS) sees them.

### add `--payment-brand unionpay` — UnionPay card enrollment

No card details are entered at the terminal. The user completes enrollment by authenticating on a UnionPay-hosted page (no OTP, no email link).

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

### Visa Network Token (async, via payment_url + FIDO passkey)

`payment-tokens visa-create` mints on the native VTS/VIC rail. The initial response is
`PENDING` and carries **`Payment URL`** — the platform-hosted page that runs the FIDO
passkey. The token flips to ACTIVE synchronously when the browser posts the assertion
back (no webhook), so the only way to observe activation is to re-read
`GET /payment-tokens/{id}`.

| Flag | Why |
|---|---|
| `--no-poll` | Return right after printing `payment_url` instead of polling up to 180s. **Required for any caller with a shorter timeout than that** — an agent gateway running the CLI as a subprocess (e.g. `CLI_TIMEOUT_SECONDS=60`) can never reach the end of the poll, and killing the read discards the URL that was already printed. The caller renders the URL and polls `payment-tokens get` on its own cadence. |
| `--no-notify` | Sends `notify_cardholder=false` so the platform does **not** also email the link. Use it whenever you hand `payment_url` to the cardholder yourself: the emailed link is the **same one-time link**, so two entry points compete — whichever is used first revokes the session and the other reports "this payment link is no longer valid". |

```bash
# Blocking form: prints payment_url, then waits for the passkey (up to 180s)
agenzo-token-cli payment-tokens visa-create --api-key <key> \
  --payment-method-id <visa_pm_id> --order-amount-cents 12345 \
  --idempotency-key idem_v1

# Non-blocking form for programmatic callers: URL out, poll yourself, no email
agenzo-token-cli payment-tokens visa-create --api-key <key> --format json \
  --payment-method-id <visa_pm_id> --order-amount-cents 12345 \
  --external-transaction-id <order_id> \
  --no-poll --no-notify --idempotency-key idem_v2
agenzo-token-cli payment-tokens get <ptk_id> --api-key <key>
```

- **Amount is integer cents** (`--order-amount-cents 12345` = $123.45), passed through with no unit conversion — unlike `--unionpay-amount`, which is a decimal string.
- The 180s default poll window is longer than UnionPay's 60s because completion is driven by a **human passkey action**, not a backend event.
- On timeout the token stays PENDING; re-open `payment_url` if the session has not expired, or poll `get` later.

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
| `PARAM_INVALID` | Bad `--payment-brand` / `--mode`, missing `--member`, UnionPay selected via `--card`, ambiguous card under `--yes`, or Visa resume missing `--email` | Fix the flag named in the message |
| `This card does not support Network Token` | Issuer does not support NT | Use a card that does |
| `Evo preauth failed` | PSP or issuer rejected preauth | Try another card or retry later |

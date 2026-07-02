# token-cli — Payment Methods & Tokens (`agenzo-token-cli`)

`@agenzo/token-cli` — runtime plane: manage payment methods (`payment-methods`) and mint payment tokens (`payment-tokens`). **API Key** auth (`--api-key`, the full `sk_<env>_...` string from [admin-cli](admin-cli.md) `keys create`).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, idempotency).

## Command matrix

8 commands, all API-Key auth (`--api-key`):

| Noun | Verb | Type | Description |
|---|---|---|---|
| `payment-methods` | `add` | Write | Add a payment method — Evo 3DS (`--mode manual`/`dropin`) or UnionPay enrollment (`--payment-brand unionpay`) — + poll verification |
| `payment-methods` | `list` | Read | List payment methods |
| `payment-methods` | `get` | Read | View payment method details |
| `payment-methods` | `disable` | Write | Disable a payment method |
| `payment-tokens` | `create` | Write | Create a token (VCN / Network Token / X402) |
| `payment-tokens` | `list` | Read | List payment tokens |
| `payment-tokens` | `get` | Read | View token details |
| `payment-tokens` | `revoke` | Write | Revoke a token |

## Payment Methods

```bash
agenzo-token-cli payment-methods add --api-key <key>
agenzo-token-cli payment-methods add --api-key <key> --email user@example.com --card-number 2223001870064586 --expiry 1226 --cvv 935
agenzo-token-cli payment-methods add --mode dropin --api-key <key> --email user@example.com   # Drop-in (DropInSDK) — no card details at the terminal
agenzo-token-cli payment-methods list --api-key <key>
agenzo-token-cli payment-methods get <pm_id> --api-key <key>
agenzo-token-cli payment-methods disable <pm_id> --api-key <key>
```

### add — Add Payment Method + 3DS (onboarding Step 4)

- **Ask: `--email`** — This is for 3DS verification and may differ from the developer or login email. MUST ask the user which email to use. Do NOT default to any previously used email.
- `--api-key`: Use the key from admin-cli Step 3 (do not ask again).
- Supports `--card-number`, `--expiry`, and `--cvv` flags to skip interactive prompts.
- When `--cvv` is not provided, CVV is prompted interactively (masked input).
- ⚠️ Security note: `--cvv` flag is intended for AI Agent / automation use. The value may appear in shell history.
- Initiates 3DS verification — the response carries a `verification_url`; the user must open it in a **browser** to complete 3DS (not via email).
- The CLI keeps polling status until the card becomes ACTIVE, so **the process must stay alive** for the whole 3DS flow (for automation, run it in the background; do not kill it / do not close its stdin).
- On success, the card becomes ACTIVE (a 32-char hex payment-method id).
- Duplicate cards (same first6 + last4) are overwritten, not rejected.

### add `--mode dropin` — Drop-in (DropInSDK) flow

Alternative to the manual flow: the CLI mints a hosted **LinkPay** session and the cardholder enters their card in the **DropIn SDK** widget rendered in the agent's own front-end. PAN/CVV are **never** collected by the CLI or the backend.

```bash
agenzo-token-cli payment-methods add --mode dropin --api-key <key> --email user@example.com
```

- **Ask: `--email`** — used as the LinkPay reference for the session. MUST ask the user.
- `--api-key`: reuse the key from admin-cli Step 3 (do not ask again).
- Card flags (`--card-number` / `--expiry` / `--cvv`) and `--idempotency-key` are **not** used in this mode.

**How it works:**

1. The CLI creates a LinkPay session and prints a `Session ID` (the full `{ id, session_id, merchant_trans_id, status }` payload under `--format json`).
2. The agent renders the DropIn SDK in their own front-end using that `Session ID` (see below).
3. The CLI polls verification status every 5 seconds (up to 30 minutes) — **keep the process alive** for the whole flow (run it in the background for automation; do not kill it / do not close its stdin).
4. Once the user completes the card form + 3DS in the widget, the PM becomes **ACTIVE** and the CLI prints brand + last4, then exits.
5. The resulting payment-method id can be used with `payment-tokens create` exactly like a manual-mode card.

**Drop-in front-end integration** (the agent renders this in their own web page):

1. Install the SDK:
   ```bash
   npm install cil-dropin-components
   ```
   or load via CDN:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/cil-dropin-components@latest/dist/index.min.js"></script>
   ```
2. Add a container element:
   ```html
   <div id="dropInApp"></div>
   ```
3. Initialise with the `Session ID` from the CLI output:
   ```javascript
   import DropInSDK from 'cil-dropin-components'

   const sdk = new DropInSDK({
     id: '#dropInApp',
     type: 'payment',
     sessionID: '<session_id from CLI output>',
     locale: 'en-US',
     mode: 'embedded',           // or 'bottomUp' for mobile
     environment: 'HKG_prod',    // use 'UAT' for sandbox testing
     appearance: { colorBackground: '#fff' },
     payment_completed: (data) => {
       // Added successfully — the CLI detects this via polling.
       // data: { type, merchantTransID, sessionID }
       console.log('Payment method added:', data.merchantTransID)
     },
     payment_failed: (data) => {
       // Failed — the CLI also detects this.
       // data: { type, merchantTransID, sessionID, code, message }
       console.log('Add failed:', data.message)
     },
     payment_cancelled: (data) => {
       // User cancelled — session stays PENDING, the CLI keeps polling.
       console.log('User cancelled')
     },
   })
   ```
4. That's it — the CLI handles all backend status polling and prints the final result.

**Key points:**
- The `Session ID` is one-time use. If the session expires (30 min), re-run the same command with the same `--email` to mint a fresh session — the old PENDING record is overwritten.
- `FAILED` / `EXPIRED` (or a 30-minute timeout) are reported with the `PM ID` and a non-zero exit code; the underlying card is never exposed to the CLI.

### add `--payment-brand unionpay` — UnionPay card enrollment

Bind a UnionPay card via the UPI Agent Pay enrollment flow. Unlike the Evo 3DS flow, **no card details are entered at the terminal** — the user completes card binding on a UnionPay-hosted page via passkey authentication.

```bash
agenzo-token-cli payment-methods add --payment-brand unionpay --member <member_id> --api-key <key> --email user@example.com
```

- `--payment-brand unionpay`: selects the UnionPay payment brand (default is `evo`).
- **`--member <id>`** (required): end-user identity this card belongs to. The caller defines this value (e.g. your system's user ID). Must be stable — the same member_id is reused for subsequent token creation.
- `--api-key`: API Key from admin-cli (do not ask again if already provided).
- `--email`: email address associated with this binding.
- Card details (`--card-number` / `--expiry` / `--cvv`), `--mode`, and `--idempotency-key` are **not used** in this mode.

**How it works:**

1. The CLI calls `POST /payment-methods/create` with `payment_brand=unionpay` and `member_id`.
2. The platform dispatches to UnionPay's Enrollment API and returns an `Enroll URL`.
3. The CLI prints the Enroll URL and starts polling (every 5s, up to 60s) for the card to become ACTIVE.
4. **⚠️ The user MUST open the Enroll URL in a browser** to complete card binding. On the UnionPay page, the user authenticates via **passkey** (fingerprint/face/PIN). No OTP or email verification — it's passkey-based.
5. Once the user completes binding, UnionPay sends a webhook callback to the platform, the card status transitions from PENDING → ACTIVE, and the CLI displays the activated card details (Brand, First 6, Last 4).
6. If the card is not activated within 60s, the CLI times out. The user can check status later with `payment-methods get <pm_id>`.

**Key points:**
- UnionPay card binding is **asynchronous**: the CLI prints a URL and waits — the user must act in a browser.
- The `member_id` is caller-defined and stable. Using the same `member_id` across enrollment and token creation is mandatory — mismatched values will cause UnionPay to reject the token request.
- On success, the card appears in `payment-methods list` with `payment_brand=unionpay`, same field shape as Evo cards (ID, Brand, First 6, Last 4).

## Payment Tokens

```bash
# Interactive mode
agenzo-token-cli payment-tokens create --api-key <key>

# Full-flag mode (for AI Agents, always use --yes). --idempotency-key is REQUIRED — the CLI never auto-generates one.
agenzo-token-cli --yes payment-tokens create --type vcn --api-key <key> --card 2223001870064586 --amount 30 --idempotency-key idem_001
agenzo-token-cli --yes payment-tokens create --type network-token --api-key <key> --card 2223001870064586 --idempotency-key idem_002
agenzo-token-cli --yes payment-tokens create --type x402 --api-key <key> --payment-method-id <pm_id> --pay-to 0xABC... --amount 1000000 --nonce abc123 --network base_sepolia --deadline 1777457396 --idempotency-key idem_003

# Query and revoke
agenzo-token-cli payment-tokens list --api-key <key>
agenzo-token-cli payment-tokens get <ptk_id> --api-key <key>
agenzo-token-cli payment-tokens get <ptk_id> --api-key <key> --reveal  # reveal full VCN only when needed for payment
agenzo-token-cli payment-tokens revoke <ptk_id> --api-key <key>
```

> **One-time tokens**: payment tokens are single-use — create a new one for each transaction.

### create — parameters to ask for (if not provided)

| Parameter | Ask rule |
|-----------|----------|
| `--member` | Optional. Ask if not provided, user can press Enter to skip. |
| `--amount` | MUST ask for VCN. Range: 0.01–500.00 USD. |
| `--card` | If multiple active cards exist, MUST ask which card to use. If only one active card, auto-select. |
| `--pay-to` | MUST ask for X402. |
| `--nonce` | MUST ask for X402. |
| `--network` | MUST ask for X402. |
| `--deadline` | MUST ask for X402. |
| `--idempotency-key` | MUST be supplied by the caller. The CLI does NOT auto-generate one. Provide a unique value per logical request (e.g. `idem_<uuid>`). If omitted, the CLI prompts interactively. |

Reuse from previous steps (do not ask again): `--api-key` (from admin-cli Step 3); `--type` (from the user's request; no default — interactive selector if omitted).

Card resolution priority:
1. `--payment-method-id <id>` → use directly (no API call)
2. `--card <full-number>` → fetch card list, match by last 4 digits
3. Only 1 active card → auto-select (no prompt)
4. Multiple cards → ask the user which card to use

### create — available flags

| Flag | Description | Required for |
|------|-------------|-------------|
| `--api-key <key>` | API Key (`sk_<env>_...`) | All types |
| `--type <type>` | `vcn`, `network-token`, or `x402` (no default; interactive selector) | All types |
| `--card <number>` | Card number (matches by last 4 digits) | Optional |
| `--payment-method-id <id>` | Payment method ID (skips card lookup) | Optional |
| `--member <id>` | Member ID | Optional |
| `--amount <amount>` | Amount in USD (0.01-500.00) | VCN |
| `--currency <code>` | Currency code (default: USD) | VCN |
| `--pay-to <address>` | Recipient address | X402 |
| `--nonce <nonce>` | Nonce value | X402 |
| `--network <network>` | Chain network (e.g. `base`) | X402 |
| `--deadline <timestamp>` | Unix timestamp deadline | X402 |
| `--external-tx-id <id>` | External transaction ID. Sent only when supplied; the CLI does not auto-generate one. | Optional |
| `--idempotency-key <key>` | Idempotency-Key header value. Required — must be supplied by the caller. Prompts interactively if omitted; never auto-generated. Sent as the `Idempotency-Key` HTTP header, never in the body. | All types |

### Token Types

| Type | Description | Card Requirement |
|------|-------------|-----------------|
| `vcn` | Virtual card with spend limit | Any ACTIVE card |
| `network-token` | Cryptogram for card-present payments | Card must support Network Token |
| `x402` | On-chain payment signature | Any ACTIVE card |

### Pre-authorization Confirmation

VCN, X402, and Network Token all involve pre-authorization (fund freeze) on a gateway token, followed by capture or cancel:
- VCN: Frozen amount = amount + service fee (5%). Displayed as concrete dollar values.
- X402: Amount converted from USDC smallest units to USD (1 USD = 1,000,000 units). Service fee 5%.
- Network Token: Flat service fee charged via gateway token. The amount is fetched at runtime from `GET /config/network-token-fee` (default $0.50 if the endpoint is unreachable).
- Use the `--yes` global flag to skip confirmation (always use this when executing for the user).

### Network Token Compatibility

Not all cards support Network Token. Depends on issuer and card network, not brand. How to check: after the payment method is added, the `evo_data.network_token` field has a value if supported, empty if not. Cards without support return: `This card does not support Network Token.`

### UnionPay Network Token (async, via Checkout URL)

For UnionPay cards (`payment_brand=unionpay`), network token creation is **asynchronous** — the cryptogram is not returned immediately. Instead, the user must complete a passkey authentication on a UnionPay-hosted Checkout page.

```bash
agenzo-token-cli payment-tokens create --type network-token --payment-method-id <unionpay_pm_id> --api-key <key>
```

- **Card selection**: UnionPay cards **must** be selected via `--payment-method-id`. The `--card` (last4 matching) flag does not work for UnionPay cards.
- The CLI automatically detects the card's `payment_brand` and enters the UnionPay branch (prompting for amount, recipient info, etc.).
- **No `--idempotency-key` needed** for the initial request (the platform uses correlation IDs for idempotency).

**How it works:**

1. The CLI collects: Member ID (optional), amount (USD), recipient name, recipient email or phone.
2. The platform calls UnionPay's Create_Intent + Checkout APIs and returns a `Checkout URL`.
3. The CLI prints the Checkout URL and starts polling (every 5s, up to 60s) for the token to become ACTIVE.
4. **⚠️ The user MUST open the Checkout URL in a browser** and complete **passkey authentication** (fingerprint/face/PIN) on the UnionPay page.
5. Once authenticated, UnionPay sends a webhook callback with the cryptogram. The token transitions from PENDING → ACTIVE.
6. The CLI displays the activated token: Token Number, Cryptogram, Expiry.

**Output fields (ACTIVE token — used for payment):**

| Field | Description | Used for payment |
|-------|-------------|-----------------|
| Token Number | UnionPay-issued virtual card number (replaces real PAN) | Yes — send as "card number" to acquirer |
| Cryptogram | One-time payment credential (`dynamicDataValue`) | Yes — required by acquirer for verification |
| Expiry | Token expiration (MMYY) | Yes |
| ECI | E-commerce indicator (may not be present in UPI mode) | Optional |

**If timeout (60s):** The token stays PENDING. Check later with `payment-tokens get <ptk_id>`. The user can re-open the Checkout URL if it hasn't expired.

### VCN / X402 Compatibility

VCN and X402 require a `gateway_token` in `evo_data`. If missing (3DS not completed properly): `This card does not support VCN/X402. Gateway token is missing.`

### VCN Server-Side Feature Switch

Before running any VCN-specific prompts, the CLI checks `GET /features/vcn`. If disabled, the CLI fast-fails (no card/amount inputs collected) with errorCode `TOKEN_FEATURE_DISABLED` (`code_num` 4001), message `VCN creation is not supported yet. Coming soon.`, exit code 1.

When this happens, DO NOT retry `payment-tokens create --type vcn` with different parameters — the block is global, not parameter-dependent. Suggest the user switch to `--type network-token` or `--type x402` if their use case allows. Network Token and X402 are NOT gated by this switch.

### Revoke Behavior

| Card Brand | Revoke Action |
|------------|---------------|
| **Visa** | No action needed. Cryptogram auto-expires in 24 hours. |
| **MasterCard** | No action needed. Cryptogram auto-expires in 5 days. |

## Token-specific errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No active payment methods found` | API key belongs to a different developer | Use the correct API key |
| `This card does not support Network Token` | Issuer does not support NT | Add a payment method that supports NT |
| `Evo preauth failed` | PSP or issuer rejected preauth | Try a different card or retry later |

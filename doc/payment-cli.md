# payment-cli — Capture Plane (`agenzo-payment-cli`)

`@agenzo/payment-cli` — capture (charge) a previously created payment token. **API Key** auth
(`--api-key`, sent as the `X-Api-Key` header).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes,
API key format, idempotency).

## Command matrix

| Noun | Verb | Type | Description |
|---|---|---|---|
| `payments` | `capture` | Write | Capture (charge) a previously created payment token |

## Prerequisite: create a payment token first

`payments capture` does **not** accept an amount or currency — the amount, currency, and any fee
are fixed when the payment token was created (`agenzo-token-cli payment-tokens create`).
`payments capture` only submits the charge for that exact token:

```
[token-cli] payment-methods add → payment-tokens create → [payment-cli] payments capture
```

## `payments capture`

```bash
agenzo-payment-cli payments capture \
  --api-key sk_test_... \
  --payment-token-id ptk_abc123 \
  --idempotency-key <unique-per-charge> \
  --yes
```

| Flag | Required | Description |
|---|---|---|
| `--api-key` | yes | API Key, sent as the `X-Api-Key` header. If omitted, the CLI prompts for it as a masked password — including under `--yes`. |
| `--payment-token-id` | yes | The payment token to charge (`ptk_...`). Prompted if omitted; a hard error under `--yes`. |
| `--payment-brand` | no | Override only — `evo` or `unionpay` (case-insensitive). Omitted from the request body by default so the platform auto-detects the brand from the token record. Any other value is rejected locally as `PARAM_INVALID`. |
| `--description` | no | Free-text description; sent in the body only when provided. |
| `--idempotency-key` | yes | Unique value per logical charge attempt; forwarded verbatim as the `Idempotency-Key` header (never in the body) and **never auto-generated**. Prompted if omitted; a hard error under `--yes`. Reuse the same value to safely retry the same charge. |

Global flags (`--yes`, `--format json|table`, `--verbose`) are defined on the program root and
apply to every verb. Amount, currency, and fee are **not** flags — see the prerequisite above.

**Auto-detection**: The platform reads `payment_brand` from the payment token document.
You do NOT need to specify `--payment-brand` — the CLI omits it by default and the server
routes to the correct payment rail automatically (evo gateway token vs unionpay network token).

### Output

On success, prints the charge identifier, final status, and the amount breakdown
(principal / fee / total — all taken from the token, not recomputed at pay time):

```bash
agenzo-payment-cli payments capture --api-key sk_test_... --payment-token-id ptk_abc123 \
  --idempotency-key charge-2026-07-03-001 --yes --format json
```

```json
{
  "profile": "production",
  "endpoint": "https://agent.agenzo.com",
  "charge_no": "chg_...",
  "payment_brand": "unionpay",
  "amount_cents": 1200,
  "fee_cents": 0,
  "total_cents": 1200,
  "currency": "USD",
  "pay_status": "success",
  "merchant_trans_id": "...",
  "evo_trans_id": "..."
}
```

`pay_status` is one of `success` / `failed` / `pending`. A `pending` result means the upstream
payment gateway had not reached a terminal state within the platform's bounded poll window —
retry with the **same** `--idempotency-key` to check the outcome safely (it will not double-charge).

### Response fields

| Field | Type | Notes |
|---|---|---|
| `charge_no` | string | Platform charge identifier |
| `payment_brand` | string | Brand actually used (`evo` / `unionpay`) |
| `amount_cents` | integer | Principal, in **cents** |
| `fee_cents` | integer | Fee, in **cents** |
| `total_cents` | integer | `amount_cents + fee_cents`, in **cents** |
| `currency` | string | ISO currency of the token |
| `pay_status` | string | `success` / `failed` / `pending` |
| `merchant_trans_id` | string? | Absent on some rails; rendered as `-` in table mode |
| `evo_trans_id` | string? | Absent on some rails; rendered as `-` in table mode |
| `result_code`, `result_message` | string? | Upstream gateway detail, present mainly on failures |

`profile` and `endpoint` are prefixed by the shared JSON envelope, not returned by the server.

> **Amount unit**: `payments capture` returns **integer cents** (`1200` = 12.00). This differs
> from amount inputs elsewhere in the toolchain (e.g. `agenzo-token-cli payment-tokens create`),
> which take **decimal strings** (`"12.00"`). Table mode formats cents for display; `--format json`
> gives you the raw integers — do not divide twice.

## Payment-specific errors

| Error | Cause | Fix |
|-------|-------|-----|
| `TOKEN_NOT_FOUND` (exit 1) | The payment token id doesn't exist, or belongs to a different API key's developer | Verify the token id with `agenzo-token-cli payment-tokens get <id>` |
| `INVALID_PAYMENT_METHOD` (exit 1) | The token is not active, or is missing the credential needed for the detected brand | Re-check the token status; unionpay tokens must be ACTIVE (cryptogram issued) before they can be charged |
| `PARAM_INVALID` (exit 1) | `--payment-brand` is not `evo` or `unionpay`, or `--payment-token-id` is missing under `--yes` | Pass a supported brand (or omit it for auto-detection) and always supply `--payment-token-id` in automation |
| Missing `--idempotency-key` under `--yes` (exit 1) | Automation mode requires an explicit idempotency key — the CLI never auto-generates one | Supply a unique `--idempotency-key` per charge attempt |
| Upstream error (exit 4), `pay_status: "pending"` | The gateway had not reached a terminal state within the bounded poll window | Retry with the same `--idempotency-key`; it is safe and will not double-charge |

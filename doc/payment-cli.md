# payment-cli — Capture Plane (`agenzo-payment-cli`)

`@agenzo/payment-cli` — capture (charge) a previously created payment token. **API Key** auth
(`--api-key`, sent as the `X-Api-Key` header).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes,
API key format, idempotency).

## Command matrix

1 command (top-level).

| Command | Type | Description |
|---|---|---|
| `capture` | Write | Capture (charge) a previously created payment token |

## Prerequisite: create a payment token first

`capture` does **not** accept an amount or currency — the amount, currency, and any fee
are fixed when the payment token was created (`agenzo-token-cli payment-tokens create`).
`capture` only submits the charge for that exact token:

```
[token-cli] payment-methods add → payment-tokens create → [payment-cli] capture
```

## `capture`

```bash
agenzo-payment-cli capture \
  --api-key sk_test_... \
  --payment-token-id ptk_abc123 \
  --idempotency-key <unique-per-charge> \
  --yes
```

| Flag | Required | Description |
|---|---|---|
| `--api-key` | yes | API Key (`X-Api-Key` header) |
| `--payment-token-id` | yes | The payment token to charge (`ptk_...`) |
| `--payment-brand` | no | Optional override. The platform auto-detects the brand from the token record (`evo` or `unionpay`). Pass only to assert/verify — mismatch results in an error. |
| `--description` | no | Optional free-text description forwarded to the platform |
| `--idempotency-key` | yes | Unique value per logical charge attempt; forwarded as the `Idempotency-Key` header (never in the body). Reuse the same value to safely retry the same charge; the platform returns the original result rather than charging twice. |

**Auto-detection**: The platform reads `payment_brand` from the payment token document.
You do NOT need to specify `--payment-brand` — the CLI omits it by default and the server
routes to the correct payment rail automatically (evo gateway token vs unionpay network token).

### Output

On success, prints the charge identifier, final status, and the amount breakdown
(principal / fee / total — all taken from the token, not recomputed at pay time):

```bash
agenzo-payment-cli capture --api-key sk_test_... --payment-token-id ptk_abc123 \
  --idempotency-key charge-2026-07-03-001 --yes --format json
```

```json
{
  "profile": "production",
  "endpoint": "https://agent.everonet.com",
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

## Payment-specific errors

| Error | Cause | Fix |
|-------|-------|-----|
| `TOKEN_NOT_FOUND` (exit 1) | The payment token id doesn't exist, or belongs to a different API key's developer | Verify the token id with `agenzo-token-cli payment-tokens get <id>` |
| `INVALID_PAYMENT_METHOD` (exit 1) | The token is not active, or is missing the credential needed for the detected brand | Re-check the token status; unionpay tokens must be ACTIVE (cryptogram issued) before they can be charged |
| `INVALID_REQUEST` (exit 1) | `--payment-brand` override conflicts with the token's actual brand | Omit `--payment-brand` (auto-detection) or pass the correct value |
| Missing `--idempotency-key` under `--yes` (exit 1) | Automation mode requires an explicit idempotency key — the CLI never auto-generates one | Supply a unique `--idempotency-key` per charge attempt |
| Upstream error (exit 4), `pay_status: "pending"` | The gateway had not reached a terminal state within the bounded poll window | Retry with the same `--idempotency-key`; it is safe and will not double-charge |

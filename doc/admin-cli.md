# admin-cli — Control Plane (`agenzo-admin-cli`)

`@agenzo/admin-cli` — control plane: authentication, organizations, developers, API keys, settlement accounts, and CLI config. **Bearer Token** auth (obtained via `auth login`; credentials stored locally in `~/.agenzo-admin-cli/`).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, API key format, idempotency).

## Global flags

| Flag | Meaning |
|---|---|
| `--format <json\|table>` | Output format (default `table`; or set `AGENZO_FORMAT`) |
| `--yes` | Skip confirmation prompts (automation / AI agents) |
| `--verbose` | Show verbose logs (raw dump for non-CLI errors) |

Payload goes to stdout; status/progress lines go to stderr and only in `table` mode. Errors exit 1–5 with `✗ [<code_num>] <message>` (table) or a `{ error: {...} }` envelope (json).

## Command matrix

19 commands across 6 nouns. `config` and the local `orgs` verbs (`list`, `switch`) are pure-local (no network); all others use the stored Bearer Token.

| Noun | Verbs | Description |
|---|---|---|
| `auth` | `login` / `logout` | Magic-link sign-in / sign out |
| `config` | `set-host` / `show` / `reset-host` | Manage the API host (local only) |
| `orgs` | `get` / `list` / `switch` / `update` | Organization info and active-org switch |
| `developers` | `create` / `list` / `get` / `update` | Manage developers |
| `keys` | `create` / `list` / `get` / `rotate` / `disable` | Manage API keys |
| `accounts` | `get` | Query a settlement account |

## Idempotency (every write)

`--idempotency-key <key>` is **mandatory on every server write** — `auth login`, `orgs update`, `developers create|update`, `keys create|rotate|disable`. The CLI never auto-generates it: without the flag it prompts interactively, and under `--yes` it fails immediately (`IDEMPOTENCY_KEY_REQUIRED`, exit 1). Use a unique value per logical write and reuse it verbatim when retrying.

Any other missing flag listed below is also prompted for interactively — so in automation (`--yes`) pass **all** of them, or the command blocks on a prompt.

## Onboarding (control-plane half: Steps 1–3)

```
[admin-cli] auth login → developers create → keys create → [token-cli] payment-methods add → payment-tokens create
```

### Step 1: Login

**Ask: `--email`** — MUST ask the user for their email address before executing. Never assume or use a default.

```bash
agenzo-admin-cli auth login --email user@example.com --idempotency-key login-2026-08-12-01
```

- First-time users are auto-registered (prompts for org name).
- **Invitation code**: if registration requires one (error `1103`), the CLI prompts `Invitation code:` and retries registration automatically. MUST ask the user for it; never guess.
- Sends a magic link to the email; the CLI polls until the link is clicked (timeout 10 minutes).
- Credentials are stored in `~/.agenzo-admin-cli/`.
- `auth logout` signs out of the current organization (re-login via magic link to restore the session).

### Step 2: Create Developer

```bash
agenzo-admin-cli developers create \
  --developer-name "My Agent" --developer-email agent@example.com \
  --bank-beneficiary-name "My Agent LLC" --bank-account-number 1234567890123456 \
  --bank-name "Test Bank" --bank-country US --bank-swift-code TESTUS33 \
  --idempotency-key dev-create-001
```

| Flag | Required | Notes |
|---|---|---|
| `--developer-name <name>` | yes | |
| `--developer-email <email>` | yes | **Ask the user**; if they decline, fall back to the Step 1 login email |
| `--billing-mode <mode>` | no | `pay_per_call` (default) \| `monthly_settlement`; invalid value → `PARAM_INVALID`, exit 1 |
| `--settlement-currency <code>` | no | ISO 4217 (e.g. `USD`, `CNY`); only meaningful for `monthly_settlement`, defaults to the platform setting (USD) |
| `--idempotency-key <key>` | yes | see [Idempotency](#idempotency-every-write) |
| `--bank-*` | yes | see below |

- Returns `developer_id` — save it for Step 3.
- **Bank account is mandatory for every developer, regardless of `--billing-mode`** — it is the payout target for transfers to this developer.
- One developer has exactly one bank account. The account number is always masked in responses (e.g. `************3456`).
- One org can have multiple developers; the same email can create only one developer per org.

#### `--bank-*` flag group (shared by `developers create` / `update`)

| Flag | Required | Notes |
|---|---|---|
| `--bank-beneficiary-name <name>` | yes | |
| `--bank-account-number <number>` | yes | Account number or IBAN; 4–34 alphanumeric, no spaces/punctuation |
| `--bank-name <name>` | yes | |
| `--bank-country <code>` | yes | ISO 3166-1 alpha-2 (e.g. `US`, `CN`) |
| `--bank-swift-code <code>` | yes | SWIFT/BIC, 8 or 11 alphanumeric characters |
| `--bank-address <address>` | no | |
| `--bank-routing-number <number>` | no | e.g. US ABA |

### Step 3: Create API Key

```bash
agenzo-admin-cli keys create --developer-id <developer_id> --key-name "My Key" \
  --scope token,merchant,payment --idempotency-key key-create-001
```

- **Ask: `--key-name`** — MUST ask the user what name to use. If they decline, generate a random name (e.g. `key-<random-4-chars>`).
- `--developer-id`: the value from Step 2 (do not ask again).
- `--scope` (optional): comma-separated subset of `token`, `merchant`, `payment` — `token` → `agenzo-token-cli`, `merchant` → `agenzo-merchant-cli`, `payment` → `agenzo-payment-cli`. Default is all three (also the `--yes` default); interactively a checkbox is shown with all pre-checked. Unknown values fail locally (`PARAM_INVALID`, exit 1).
- Returns the full API key (**shown only once**) — remind the user to save it. It is also persisted to the local key store for the active org.
- Key format: `sk_<env>_...` — `sk_prod_` in production, `sk_test_` in test/dev. Do not assume `sk_prod_`.
- Used for all Runtime Plane operations (`agenzo-token-cli`, `agenzo-merchant-cli`, `agenzo-payment-cli`).

## Organizations

```bash
agenzo-admin-cli orgs get                            # Current org (network)
agenzo-admin-cli orgs list                           # All signed-in orgs (local)
agenzo-admin-cli orgs switch <org_id>                # Switch active org (local)
agenzo-admin-cli orgs update --name "New Org Name" --idempotency-key org-upd-001
agenzo-admin-cli orgs update --email new@example.com --idempotency-key org-upd-002
```

- `orgs update` flags: `--name`, `--email` (supply at least one), `--idempotency-key`.
- An email change is not applied inline — the backend returns a magic-link verification payload; the new address must confirm. The verification token is deliberately never printed.
- `orgs switch` requires that org to already be signed in.

## Developers

```bash
agenzo-admin-cli developers list
agenzo-admin-cli developers get <developer_id>
agenzo-admin-cli developers update <developer_id> --name "New Name" --idempotency-key dev-upd-001
agenzo-admin-cli developers update <developer_id> --email new@example.com --idempotency-key dev-upd-002
# Replace the bank account wholesale (all required --bank-* flags together):
agenzo-admin-cli developers update <developer_id> \
  --bank-beneficiary-name "My Agent LLC" --bank-account-number 9999888877776666 \
  --bank-name "New Bank" --bank-country US --bank-swift-code NEWBUS33 \
  --idempotency-key dev-upd-003
```

- `developers update` takes `<developer_id>` as a positional argument, plus `--name` / `--email` (note: **not** `--developer-name` / `--developer-email`, which belong to `create`).
- The stored bank account is left untouched unless at least one `--bank-*` flag is supplied — in that case every required bank field must resolve (flag or prompt), since the account is replaced wholesale, not patched field-by-field.

## API Keys

```bash
agenzo-admin-cli keys list --developer-id <dev_id>
agenzo-admin-cli keys get <key_id>
agenzo-admin-cli keys rotate <key_id> --idempotency-key key-rot-001    # New key value; old one invalidated
agenzo-admin-cli keys disable <key_id> --idempotency-key key-dis-001   # Permanently disable
```

- `keys list --developer-id` is effectively required (prompted when omitted); it returns metadata only — the plaintext key never appears on a read command.
- `keys get` / `rotate` / `disable` take `<key_id>` (the key ID, not the `sk_...` value) as a positional argument.
- `rotate` prints and re-stores the new plaintext key, shown only once.
- Keys are bound to a developer: cards/tokens created with Key A are NOT visible to Key B.

## Settlement Accounts

```bash
agenzo-admin-cli accounts get --developer-id <developer_id>
```

- `accounts get` — the verb is `get` (not `list`); `--developer-id` is prompted when omitted.
- Auto-provisioned for developers created with `--billing-mode monthly_settlement` (currency from `--settlement-currency`).
- When no account exists, the command succeeds and returns `account: null` (table mode prints an info line about completing offline contract signing).
- `balance` is in minor units, as a string (e.g. `"3000000"` = $30,000.00). Booking a ride in `monthly_settlement` mode deducts the fare; cancelling refunds it (see [merchant-cli](merchant-cli.md)). There is no CLI top-up command.

## Configuration

```bash
agenzo-admin-cli config set-host testing     # Built-in profile → https://agent-dev.agenzo.com
agenzo-admin-cli config set-host production  # Built-in profile → https://agent.agenzo.com
agenzo-admin-cli config set-host https://my-host.example.com   # Or any custom URL
agenzo-admin-cli config show                 # Current host / API path / active org
agenzo-admin-cli config reset-host           # Reset to default (https://agent.agenzo.com)
```

- Built-in profiles: `production`, `testing`. An unknown profile name or malformed URL fails locally (`PARAM_INVALID`, exit 1).
- Switching hosts re-points the active org to the one signed in on that host; if none, the CLI tells you to log in.

## Admin-specific errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Invitation code required` (code `1103`) | Registration requires an invitation code | Ask the user for their invitation code at the interactive prompt |
| Idempotency key required (exit 1) | A write ran under `--yes` without `--idempotency-key` | Pass `--idempotency-key <unique-value>` |
| `Duplicate key error` | Developer with same email already exists in this org | Use `developers list` to find the existing one |
| `email: value is not a valid email address` | Invalid email format | Check the email format |
| Login timed out (10 minutes) | Magic link was not clicked in time | Re-run `auth login` |

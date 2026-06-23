# admin-cli — Control Plane (`agenzo-admin-cli`)

`@agenzo/admin-cli` — control plane: authentication, organizations, developers, API keys, settlement accounts, and CLI config. **Bearer Token** auth (obtained via `auth login`; credentials stored locally in `~/.agenzo-admin-cli/`).

See [SKILL.md](../SKILL.md) for shared conventions (behavior rules, `--yes`, exit codes, API key format, idempotency).

## Onboarding (control-plane half: Steps 1–3)

The end-to-end flow starts here, then continues in `agenzo-token-cli`:

```
[admin-cli] auth login → developers create → keys create → [token-cli] payment-methods add → payment-tokens create
```

### Step 1: Login

**Ask: `--email`** — MUST ask the user for their email address before executing. Never assume or use a default.

```bash
agenzo-admin-cli auth login --email user@example.com
```

- First-time users are auto-registered (prompts for org name)
- **Invitation code**: If the backend requires an invitation code for new registrations (error `1103`), the CLI will prompt `Invitation code:` interactively. MUST ask the user to provide it; do not generate or guess a value. The CLI sends it as the `invitation_code` field and retries registration automatically.
- Sends a magic link to the email
- CLI polls until the link is clicked (up to 10 minutes)
- Credentials are stored locally in `~/.agenzo-admin-cli/`
- `auth logout` signs out of the current organization (you must re-login via magic link to restore the session).

### Step 2: Create Developer

```bash
agenzo-admin-cli developers create --developer-name "My Agent" --developer-email agent@example.com
```

- **Ask: `--developer-email`** — MUST ask the user which email to use. If the user declines, fall back to the login email from Step 1.
- Returns `developer_id` — save it for Step 3.
- `--billing-mode` (optional): `pay_per_call` (default) or `monthly_settlement`. A `monthly_settlement` developer is auto-provisioned a settlement account (see Settlement Accounts).
- One org can have multiple developers
- Same email can only create one developer per org

### Step 3: Create API Key

```bash
agenzo-admin-cli keys create --developer-id <developer_id> --key-name "My Key"
```

- **Ask: `--key-name`** — MUST ask the user what name to use. If the user declines, generate a random name (e.g. `key-<random-4-chars>`).
- `--developer-id`: Use the value from Step 2 (do not ask again).
- `--scope` (optional): comma-separated `token,merchant,payment` (default: all three). `--yes` defaults to all; otherwise an interactive checkbox is shown. Invalid values fail locally (`PARAM_INVALID`, exit 1).
- Returns the full API key (shown only once!) — remind the user to save it.
- Key format: `sk_<env>_...` — the prefix is set by the server's `AGENT_PAY_API_KEY_PREFIX`: `sk_prod_` in production, `sk_test_` in test/dev (e.g. agent-dev). Do not assume `sk_prod_`.
- Used for all Runtime Plane operations (`agenzo-token-cli`, `agenzo-merchant-cli`).

## Organizations

```bash
agenzo-admin-cli orgs get                              # View current org
agenzo-admin-cli orgs list                             # List all signed-in orgs
agenzo-admin-cli orgs switch <org_id>                  # Switch active org
agenzo-admin-cli orgs update --name "New Org Name"     # Update org name
agenzo-admin-cli orgs update --email new@example.com   # Update org email (requires verification)
```

## Developers

```bash
agenzo-admin-cli developers create --developer-name "My Agent" --developer-email agent@example.com --billing-mode monthly_settlement
agenzo-admin-cli developers list
agenzo-admin-cli developers get <developer_id>
agenzo-admin-cli developers update <developer_id> --name "New Name"
agenzo-admin-cli developers update <developer_id> --email new@example.com
```

## API Keys

```bash
agenzo-admin-cli keys create --developer-id <dev_id> --key-name "Prod Key" --scope token,merchant,payment
agenzo-admin-cli keys list --developer-id <dev_id>
agenzo-admin-cli keys get <key_id>
agenzo-admin-cli keys rotate <key_id>     # Generate new key value (old one invalidated)
agenzo-admin-cli keys disable <key_id>    # Permanently disable key
```

- Keys are bound to a developer. Cards/tokens created with Key A are NOT visible to Key B.
- `--api-key` takes the full key string (`sk_<env>_...`), not the key ID.

## Settlement Accounts

```bash
agenzo-admin-cli accounts get --developer-id <developer_id>
```

- Auto-created when a developer is created with `--billing-mode monthly_settlement`.
- Returns `account: null` for `pay_per_call` developers (read-only query; no error).
- `balance` is in minor units, as a string (e.g. `"3000000"` = $30,000.00). Booking a ride in `monthly_settlement` mode deducts the fare; cancelling refunds it (see [merchant-cli](merchant-cli.md)). There is no CLI top-up command.

## Configuration

```bash
agenzo-admin-cli config set-host http://localhost:8000  # Set API host (local dev, or a profile name e.g. production)
agenzo-admin-cli config show                            # Show current host / active org
agenzo-admin-cli config reset-host                      # Reset host to default (https://agent.everonet.com)
```

## Admin-specific Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Invitation code required` (code `1103`) | Registration requires an invitation code | Ask the user for their invitation code at the interactive prompt |
| `Duplicate key error` | Developer with same email exists | Use `developers list` to find existing |
| `email: value is not a valid email address` | Invalid email format | Check email format |

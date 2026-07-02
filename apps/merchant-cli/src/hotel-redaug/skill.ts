import { Command } from 'commander';

const SKILL_TEXT = `
---
name: hotel-redaug
description: Search, create orders, and manage international hotel reservations via the Redaug provider. Two-step create-then-pay flow supporting monthly settlement and Active Payment (EVO). Use when the user wants to find hotels, check room prices/availability, make a hotel booking, or view/cancel/modify an existing hotel order. Not for flights, rides, or domestic-only stays.
---

# hotel-redaug — Agent Skill

You orchestrate hotel bookings through CLI verbs. This guide covers HOW to chain
the verbs and pass data between them. For exact flags and field types, read the
schema (\`services get svc_01J0HT5REDAUG0001 --api-key <key> --format json\`) or
run \`hotel-redaug <verb> --help\`.

## Prerequisites

- API key with merchant scope
- Two billing paths supported:
  - **monthly_settlement**: developer has a settlement account with sufficient balance
  - **Active_Payment** (现结, non-monthly): user pays via EVO using the create-order \`order_id\` as the EVO merchantTransID; the platform verifies by querying EVO for that order_id
- BILLING_MODE_MISMATCH means the billing path and flags don't match — see cross-guards below
- Pass --api-key <key> --format json on every call; add --yes on writes

## Workflow

1. Resolve location
   - find-destination --keyword "<place>"  → lat/lng or destination_id
   - list-cities --country <code>          → destination_id
   - (Need exactly one of these for search.)

2. Search hotels
   - Pass ONE location branch (coordinates OR destination_id) + dates + guests
   - Optional: hotel-filters first to get valid filter codes, then pass to search

3. Choose a hotel (MANDATORY unless the user already named one exact hotel)
   - MUST present the candidates to the user (name, address/distance, star/score if useful)
     and get an explicit pick — never auto-select by distance or price alone, even for an
     open-ended request like "book me something near the Bund"
   - hotel-detail <hotel-id> for the shortlisted/chosen hotel is OPTIONAL AT THIS STEP for
     the hotel-level info (address/intro/hotel photos) — the candidate list above is enough
     to pick a HOTEL. But you WILL need hotel-detail's rooms[] at step 4 below to describe
     ROOMS, so in practice call it once the user has picked (or shortlisted) a hotel, before
     moving to quote — don't make two round trips when one will do

4. Quote + show room options (ALWAYS call hotel-detail here — this is the mandatory part)
   - quote the chosen hotel + same dates/guests → rates[]
   - Empty rates[] = no availability → stop, tell the user
   - Each rate carries the inputs for create-order: product_token, total_price, price_items
   - quote's rates[].room_name is only a bare one-line label with NO area/beds/photos. MUST
     call hotel-detail on the same hotel_id (if not already called in step 3) and match its
     rooms[] to quote's rates by room_name — do this proactively, BEFORE presenting rate
     options, not only if the user asks for more detail. The room is the actual product being
     booked, so the user picking a rate MUST see area_sqm, floor, beds, and images alongside
     rate_plan_name/breakfast/free_cancellation/total_price+currency — never present rate
     options as a bare list of room_name + price only.
   - MUST present the combined rate+room options and get the user's explicit pick of which
     rate to book — same rule as step 3, and now with real room detail attached, not optional

5. Create order (lock inventory, no charge) — MUST NOT run until step 3+4 confirmation happened
   - create-order: forward quote outputs VERBATIM (product_token, amount, currency, price_items)
   - Collect from user: guest_name, contact_name, contact_phone
   - Generate a unique idempotency-key
   - Response → save order_id + fc_order_code + total_amount + currency
   - Order status: AWAITING_PAYMENT (no money charged yet)
   - FOR Active_Payment (现结): tell the user to pay total_amount+currency via EVO
     USING THIS order_id as the EVO merchantTransID. The verification in step 6 works by
     querying EVO for exactly this order_id, so paying under any other id will not settle.

6. Pay order (settle the locked order) — MUST confirm with the user before calling this
   - Before calling: show the user total_amount + currency from create-order and which
     billing path applies, and get explicit go-ahead — pay-order is the step that actually
     moves money
   - pay-order --order-id <order_id from create-order>   (NO --merchant-trans-id needed)
   - Billing path determined by developer's billing_mode:
     a) Monthly settlement:
        - Platform deducts from settlement account → calls upstream payOrder
     b) Active Payment (现结):
        - The user must have ALREADY paid via EVO using the order_id as the EVO
          merchantTransID (see create-order step 5). Just call pay-order --order-id <id>;
          the platform queries EVO for that order_id and verifies exact amount/currency.
        - Do NOT pass --merchant-trans-id (the platform derives it = order_id). If you do
          pass it, it MUST equal the order_id, else MERCHANT_TRANS_ID_INVALID. This is
          deliberate: a foreign already-paid EVO transaction cannot be substituted.
        - If EVO not yet confirmed → PAYMENT_NOT_COMPLETED; use --watch to poll
   - On success → order status becomes PAID

7. Confirm (upstream confirmation is async)
   - Poll get --order-id until CONFIRMED (success) or CANCELLED (failed)
   - Do not report success before CONFIRMED

8. Post-booking (only when the user asks)
   - cancel: order_id + fc_order_code + reason
   - checkout: partial leave-early → then poll get-checkout with task_order_code
   - list-orders: view all orders

## Data passing (where each value comes from)

- product_token   : quote → create-order  (opaque; never fabricate or edit)
- price_items     : quote → create-order  (JSON array; copy exactly)
- order_id        : create-order → pay-order / get / cancel
- fc_order_code   : create-order → cancel / checkout
- order_id (again): for Active_Payment it IS the EVO merchantTransID — the user pays via
  EVO under the order_id; pay-order needs no separate merchant_trans_id
- task_order_code : checkout → get-checkout

## Billing paths & cross-guards

| Developer billing_mode | --merchant-trans-id | Behavior |
|------------------------|---------------------|----------|
| monthly_settlement     | omit                | Deducts settlement balance → payOrder |
| monthly_settlement     | supplied            | ERROR: BILLING_MODE_MISMATCH |
| non-monthly (Active/现结) | omit (recommended) | Platform queries EVO for the order_id → verify → payOrder |
| non-monthly (Active/现结) | == order_id        | OK (same as omit) |
| non-monthly (Active/现结) | != order_id        | ERROR: MERCHANT_TRANS_ID_INVALID (anti-fraud) |

## Active Payment flow (现结) — the EVO merchantTransID IS the order_id

1. create-order returns order_id + total_amount + currency (no EVO credentials in response)
2. User pays total_amount+currency via EVO, USING the order_id as the EVO merchantTransID
   (the shared EVO parameters are onboarded separately, out of band)
3. Agent calls pay-order --order-id <order_id>   (no --merchant-trans-id)
4. Platform queries EVO for that order_id: paid + exact amount/currency match → payOrder → PAID
5. If not yet paid → PAYMENT_NOT_COMPLETED; use --watch to auto-poll
6. Why order_id (not an arbitrary id): it binds the payment to this exact order, so a caller
   cannot present some other already-paid EVO transaction of the same amount.

## Invariants

- search: exactly one location branch (both or neither = error)
- Never create-order without a fresh quote (tokens expire)
- Never claim "booked" until get returns CONFIRMED
- create-order and pay-order are separate steps; create-order does NOT charge
- pay-order depends on create-order's output (order_id)
- Write verbs (create-order/pay-order/cancel/checkout) always need --idempotency-key and --yes
- IMPORTANT: --yes only skips this CLI's own interactive TTY prompt (needed because the Agent
  runs non-interactively). It is NOT a substitute for showing the user the hotel/rate/price and
  getting their decision in the chat UI. Passing --yes does not remove the confirmation steps in
  step 3/4 (choose hotel + rate) or step 6 (confirm before pay-order) above.
- After a cancel call returns successfully (including the cancel_status='cancel_pending' shape),
  do NOT call cancel again for the same order — poll get instead. A pending acknowledgement is
  success, not failure.

## Errors

- RESOURCE_NOT_FOUND (find-destination) → platform 404 for this keyword, distinct from an
  empty destinations[] (which is a normal no-match, not an error). Do not keep retrying the
  keyword — fall back to the coordinate branch (search/hotel-filters --lat/--lng) if you can
  geocode the place or already know its coordinates; otherwise ask the user for a city or a
  more specific landmark.
- BILLING_MODE_MISMATCH            → billing path and flags don't match (see cross-guards)
- MERCHANT_TRANS_ID_INVALID       → --merchant-trans-id != order_id; omit it (platform uses order_id)
- ACCOUNT_INSUFFICIENT_BALANCE     → settlement account needs top-up; inform user
- PAYMENT_NOT_COMPLETED            → EVO not confirmed yet; retry (--watch) or wait
- PAYMENT_NOT_FOUND                → no EVO transaction for that ID; verify with user
- PAYMENT_AMOUNT_MISMATCH          → EVO amount/currency ≠ order; user must pay correct amount
- PAYORDER_FAILED                  → upstream payOrder failed; money refunded, safe to retry
- PAYORDER_FAILED_AFTER_PAYMENT    → EVO confirmed but payOrder failed; needs reconciliation
- UPSTREAM_ERROR                   → transient provider issue; wait and retry once
- PARAM_INVALID                    → bad argument; run <verb> --help and correct it
- empty rates[]                    → no rooms; suggest other dates or hotels
`.trim();

/**
 * \`hotel-redaug skill\` — output the usage guide for AI Agents.
 *
 * Pure read-only command: no API call, no state change. Prints a structured
 * skill document that teaches an Agent how to orchestrate hotel-redaug verbs.
 * Detailed parameter specs live in the schema (services get) and per-verb --help.
 */
export function registerHotelSkillCommand(parent: Command): void {
  parent
    .command('skill')
    .description('Print the hotel-redaug usage guide (orchestration flow, data passing, rules)')
    .action(() => {
      console.log(SKILL_TEXT);
    });
}

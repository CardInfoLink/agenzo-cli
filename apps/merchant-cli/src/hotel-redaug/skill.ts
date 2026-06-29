import { Command } from 'commander';

const SKILL_TEXT = `
---
name: hotel-redaug
description: Search, book, and manage international hotel reservations via the Redaug provider. Use when the user wants to find hotels, check room prices/availability, make a hotel booking, or view/cancel/modify an existing hotel order. Not for flights, rides, or domestic-only stays.
---

# hotel-redaug — Agent Skill

You orchestrate hotel bookings through CLI verbs. This guide covers HOW to chain
the verbs and pass data between them. For exact flags and field types, read the
schema (\`services get svc_01J0HT5REDAUG0001 --api-key <key> --format json\`) or
run \`hotel-redaug <verb> --help\`.

## Prerequisites

- API key with merchant scope, developer in monthly_settlement billing mode
- BILLING_MODE_MISMATCH means the account is misconfigured — stop and inform the user
- Pass --api-key <key> --format json on every call; add --yes on writes

## Workflow

1. Resolve location
   - find-destination --keyword "<place>"  → lat/lng
   - list-cities --country <code>          → destination_id
   - (Need exactly one of these for search.)

2. Search hotels
   - Pass ONE location branch (coordinates OR destination_id) + dates + guests
   - Optional: hotel-filters first to get valid filter codes, then pass to search

3. Choose a hotel
   - Present results to the user; hotel-detail <hotel-id> for more info if asked

4. Quote
   - quote the chosen hotel + same dates/guests → rates[]
   - Empty rates[] = no availability → stop, tell the user
   - Each rate carries the inputs for book: product_token, total_price, price_items

5. Book
   - Forward quote outputs VERBATIM (product_token, amount, currency, price_items)
   - Collect from user: guest_name, contact_name, contact_phone
   - Generate a unique idempotency-key
   - Response → save order_id + fc_order_code

6. Confirm (booking is async)
   - Poll get --order-id until CONFIRMED (success) or CANCELLED (failed)
   - Do not report success before CONFIRMED

7. Post-booking (only when the user asks)
   - cancel: order_id + fc_order_code + reason
   - checkout: partial leave-early → then poll get-checkout with task_order_code
   - list-orders: view all orders

## Data passing (where each value comes from)

- product_token  : quote → book   (opaque; never fabricate or edit)
- price_items    : quote → book   (JSON array; copy exactly)
- fc_order_code  : book  → cancel/checkout
- task_order_code: checkout → get-checkout

## Invariants

- search: exactly one location branch (both or neither = error)
- Never book without a fresh quote (tokens expire)
- Never claim "booked" until get returns CONFIRMED
- Write verbs (book/cancel/checkout) always need --idempotency-key and --yes

## Errors

- BILLING_MODE_MISMATCH        → account misconfigured; cannot fix at runtime; inform user
- ACCOUNT_INSUFFICIENT_BALANCE → settlement account needs top-up; inform user
- UPSTREAM_ERROR               → transient provider issue; wait and retry once
- PARAM_INVALID                → bad argument; run <verb> --help and correct it
- empty rates[]                → no rooms; suggest other dates or hotels
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

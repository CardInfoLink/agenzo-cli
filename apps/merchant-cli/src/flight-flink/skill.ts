import { Command } from 'commander';

const SKILL_TEXT = `
---
name: flight-flink
description: Search, book, and manage international flight reservations. Two-step create-then-pay ticketing with journeyId relay for round-trip/multi-city, plus change (rebooking) and refund flows. Use when the user wants to find flights, verify a fare, book a ticket, or view/cancel/change/refund an existing flight order. Not for hotels or rides.
---

# flight-flink — Agent Skill

You orchestrate flight bookings through CLI verbs. This guide covers HOW to chain
verbs and pass data between them. For exact flags and field types, read the schema
(\`flight-flink <verb> --help --format json\`).

## Prerequisites
- API key with merchant scope. Pass --api-key <key> --format json on every call; add --yes on writes.
- Billing is decided server-side by the developer's billing_mode (monthly_settlement or pay_per_call).

## Workflow (book)
1. find-airport --keyword "<place>"    → resolve to IATA city/airport codes
2. search --trip-type <1|2|3> --journeys '<json>'
   - journeys ALWAYS carries ALL legs. For round-trip/multi-city, relay journey-id
     from the previous search into the next until price_key_ready is true.
   - Only offers where price_key_ready is true carry a real product_token; earlier-leg
     offers carry only an identifier (product_token null).
   - Code<->type consistency: tag each code with its matching type — an AIRPORT code (e.g. NRT)
     uses type 2, a CITY code (e.g. TYO) uses type 1. Mislabeling (e.g. NRT with type 1, since NRT
     is an airport whose city is TYO) is rejected with code 400 "destination not exist".
     find-airport returns the correct type per candidate (city hit → type 1 with children airports;
     airport hit → type 2) — pass code + type together verbatim.
3. verify --product-token <token from search>
   - Returns the authoritative product_token + price_changed. If price_changed, re-confirm
     the new price with the user before booking. Pass the RETURNED token to create-order.
4. create-order --product-token <verify token> --total-amount <verify total> --currency <cur>
     --contact-* --passengers '<json>' --idempotency-key <k>
   - Locks the fare, NO charge. Order status → AWAITING_PAYMENT. Save order_no.
   - passengers: gender/id_type are STRINGS ("1"/"2"); child/infant require adult_passenger_name.
5. pay-order --order-no <order_no> --idempotency-key <k>
   - Settles + triggers ticketing. Status → PAID.
6. get-order --order-no <order_no> [--watch]
   - Ticketing is asynchronous. Poll until TICKETED (ticket_infos populated). Do NOT
     report success before TICKETED. Single-passenger orders ticket in ~100-110s;
     multi-passenger orders (adult+child+infant) take longer (150s+) — widen --watch-timeout
     for multi-passenger bookings; still TICKETING past 150s is normal, not a failure.

## Change (rebooking)
- change-search → change-apply (returns change_order_no) → change-detail
- Confirm branch: pay-order the change order (settlement). Cancel branch: change-cancel.

## Refund
- refund-apply (returns refund_order_no) → refund-detail → refund-confirm --confirm 1 (confirm)
  or --confirm 2 (cancel). Cancel takes effect immediately.

## Cancel (un-ticketed order)
- cancel-order --order-no <order_no> --idempotency-key <k>  → CANCELLED + refund.
  A ticketed order is rejected upstream — use refund-apply instead.

## Data passing
- product_token : search → verify → create-order (opaque; never fabricate or edit; verify's token wins)
- order_no      : create-order → pay-order / get-order / cancel-order
- journey_id    : search → next search (relay for round-trip/multi-city)
- change_order_no / refund_order_no : *-apply → *-detail / *-confirm / pay-order (change)

## Invariants
- Never create-order without a fresh verify (tokens/prices change).
- Never claim "booked" until get-order returns TICKETED.
- create-order and pay-order are separate steps; create-order does NOT charge.
- Write verbs (create-order/pay-order/cancel-order/change-apply/change-cancel/refund-apply/
  refund-confirm) always need --idempotency-key; reuse the SAME key when retrying the same intent.
- --yes only skips this CLI's interactive prompt (for non-interactive Agents); it does NOT
  remove the requirement to confirm the flight/fare/price with the user in the chat UI.

## Errors
- INVALID_ARGUMENT     → bad argument; run <verb> --help and correct it.
- PRICE_CHANGED        → price changed since verify; re-verify and confirm the new price.
- ORDER_CREATE_FAILED  → upstream create failed; funds released. Safe to retry with same key.
- PAYMENT_FAILED       → settlement/payment failed; check balance/method and retry.
- NOT_FOUND            → no such order for this key/owner. Do NOT retry blindly.
- IDEMPOTENCY_CONFLICT → same key reused with different params; use a fresh key.
- UPSTREAM_ERROR       → transient; retry once after a short wait.
`.trim();

/** \`flight-flink skill\` — print the usage guide for AI Agents (read-only). */
export function registerFlightSkillCommand(parent: Command): void {
  parent
    .command('skill')
    .description('Print the flight-flink usage guide (orchestration flow, data passing, rules)')
    .action(() => {
      console.log(SKILL_TEXT);
    });
}

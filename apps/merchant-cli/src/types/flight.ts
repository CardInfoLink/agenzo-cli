/**
 * Response DTOs for the flight-flink command group.
 *
 * Amounts are integers (upstream convention) surfaced as-is. Field/status
 * normalization happens platform/provider-side; these types describe the
 * platform's success-envelope `data` shapes the CLI renders.
 */

export interface FlightOffer {
  /** Non-null only when `price_key_ready` — i.e. the final leg is pinned down. */
  product_token: string | null;
  price_key_ready: boolean;
  /** This candidate's own journey id(s); upstream does not echo already-selected legs. */
  journey_id?: string[];
  /** Relay key: every already-selected leg plus this candidate. Pass verbatim as `--journey-id`. */
  next_journey_ids?: string[];
  /** Air segment ids of this candidate's own leg(s); resolve via the response's `segments`. */
  segment_ids?: string[];
  /** Air segment ids of the other legs upstream paired with this candidate to price it. */
  paired_segment_ids?: string[];
  /** WHOLE-TRIP total, not a per-leg price. Absent when upstream returned no priced offer. */
  total_sale_price?: number;
  currency?: string;
  ticketing_airline?: string;
  /** Cabin class per air segment across the whole trip. */
  cabin_class?: string[];
}

export interface SearchFlightResponse {
  offers: FlightOffer[];
  price_key_ready: boolean;
  /** Which leg this result is choosing (1-based). */
  current_leg?: number;
  total_legs?: number;
  /** False means another relay round is needed with the chosen candidate's `next_journey_ids`. */
  is_final_leg?: boolean;
  /** Deprecated for relay: flattened across candidates. Use `offers[].next_journey_ids`. */
  journey_ids?: string[];
  [key: string]: unknown;
}

export interface VerifyFlightResponse {
  product_token: string;
  total_price?: number;
  currency?: string;
  price_changed: boolean;
  /** The complete itinerary being priced — every leg, not just the last one relayed. */
  journeys?: unknown[];
  [key: string]: unknown;
}

export interface CreateFlightOrderResponse {
  order_no: string;
  upstream_order_no?: string;
  pnr?: string | null;
  status: string;
  total_amount?: number;
  currency?: string;
}

export interface PayFlightOrderResponse {
  order_no: string;
  status: string;
  amount?: number;
  currency?: string;
  /** 3DS/passkey challenge URL (present with status=AUTHENTICATION_REQUIRED). */
  three_ds_url?: string;
  /** Resume handle for the network-token 3DS path (feed back as --authorized-charge-no). */
  charge_no?: string;
  /** EVO merchant trans id for the EVO-card 3DS resume path. */
  merchant_trans_id?: string;
}

export interface GetFlightOrderResponse {
  order_no: string;
  upstream_order_no?: string;
  pnr?: string | null;
  status: string;
  upstream_status?: number;
  ticket_infos?: unknown[];
  passengers?: unknown[];
  total_amount?: number;
  currency?: string;
}

export interface CancelFlightResponse {
  order_no: string;
  status: string;
  refund_amount?: number | null;
  currency?: string;
}

export interface ListFlightOrdersResponse {
  orders: Array<Record<string, unknown>>;
  total: number;
  page: number;
  page_size: number;
}

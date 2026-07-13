/**
 * Response DTOs for the flight-flink command group.
 *
 * Amounts are integers (upstream convention) surfaced as-is. Field/status
 * normalization happens platform/provider-side; these types describe the
 * platform's success-envelope `data` shapes the CLI renders.
 */

export interface FlightOffer {
  product_token: string | null;
  identifier?: string;
  price_key_ready: boolean;
  total_sale_price?: number;
  currency?: string;
  ticketing_airline?: string;
}

export interface SearchFlightResponse {
  offers: FlightOffer[];
  price_key_ready: boolean;
  journey_ids?: string[];
  [key: string]: unknown;
}

export interface VerifyFlightResponse {
  product_token: string;
  total_price?: number;
  currency?: string;
  price_changed: boolean;
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

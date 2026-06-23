// ============================================================
// merchant-cli (ride / service) business response types
// ============================================================
//
// Response shapes owned by merchant-cli, modeled on the v3 backend's actual
// responses (app/agent_pay/services/ride_service.py + the elife passthrough).
// They live here (not in @agenzo/cli-core) because only merchant-cli consumes
// them — per the monorepo convention, cross-CLI types go in cli-core, single-app
// business types stay in their owning app.
//
// The book / get / list-orders payloads have DIFFERENT shapes, so they are typed
// separately rather than sharing one `Order` interface. Monetary amounts are
// decimals in the currency's standard unit (e.g. 12.50 USD), NOT minor units.

// ---- Geo ----

export interface GeoPoint {
  lat: number;
  lng: number;
  name: string;
  address?: string | null;
}

// ---- Quote ----

export interface Price {
  amount: number;
  currency: string;
  quote_id: string;
}

export interface VehicleClass {
  vehicle_class: string;
  vehicle_class_id?: number;
  price: Price;
  passenger_capacity: number;
  luggage_capacity: number;
  typical_vehicle?: {
    make?: string;
    model?: string;
    year?: number;
  } | null;
  image_url?: string | null;
}

export interface MeetAndGreet {
  available: boolean;
  price?: { amount: number; currency: string };
}

export interface QuoteResponse {
  request_id?: string | null;
  vehicle_classes: VehicleClass[];
  meet_and_greet?: MeetAndGreet | null;
  is_airport_transfer?: boolean;
  airport_direction?: string | null;
}

// ---- Booking ----

/** Case-sensitive ride status (matches server casing exactly). */
export type OrderStatus =
  | 'NONE'
  | 'INIT'
  | 'Pending'
  | 'Accepted'
  | 'On my way'
  | 'Waiting'
  | 'On board'
  | 'At destination'
  | 'Rejected'
  | 'Cancelled'
  | 'Customer no show'
  | 'Driver no show'
  | 'Booking Failed';

/** `RideService._format_book` shape. */
export interface BookResponse {
  ride_id: string;
  order_id: string;
  status: OrderStatus | string;
  /** true = scheduled/airport ride; false = realtime ride. */
  is_scheduled: boolean;
  /** 'realtime' or 'airport' — derived from pickup_time, routes the elife account. */
  order_type: string;
  price: Price;
  payment_status: string;
  /** monthly_settlement only. */
  billing_entry_id?: string;
  /** pay_per_call only (reserved until payment-cli ships). */
  payment_order_id?: string;
}

// ---- Get status ----

export interface Driver {
  name?: string | null;
  phone_number?: string | null;
}

export interface Vehicle {
  make?: string | null;
  model?: string | null;
  color?: string | null;
  license_plate?: string | null;
  image_url?: string | null;
}

/**
 * `ride get` response. Three server paths share this shape: live elife status,
 * sandbox mock, and the local-cache fallback (`_format_local_status`, marked
 * with `source`). Pickup/dropoff are `from_location`/`to_location` here —
 * the v3 adapter dumps elife's CombinedRideResponse with by_alias=false, so the
 * keys are the snake_case python names, NOT the elife `from`/`to` aliases.
 */
export interface GetOrderResponse {
  ride_id: string | number;
  status: OrderStatus | string;
  /** 'local_cache' when served from the local fallback record; 'mock' in sandbox. */
  source?: string;
  is_scheduled?: boolean;
  from_location?: GeoPoint;
  to_location?: GeoPoint;
  pickup_time?: number | string;
  vehicle_class?: string | null;
  price?: Price;
  /** Final settled fare (realtime, after final-fare settlement); local-cache path only. */
  final_amount?: number | null;
  /** pending | settled | no_adjustment | settlement_pending | not_applicable. */
  final_settlement_status?: string;
  driver?: Driver | null;
  vehicle?: Vehicle | null;
  created_at?: string;
}

// ---- Cancellation ----

export interface Cancellation {
  cancellation_fee: number;
  reversal_amount: number;
  currency: string;
}

export interface CancelResponse {
  ride_id: string | number;
  ride_stat: string;
  cancellation: Cancellation | null;
  /** Amount credited back to the settlement balance (paid − cancellation_fee). */
  refund_amount?: number;
}

// ---- Listing ----

/** `RideService._format_list_item` shape (MongoDB ap_ride_orders, slim). */
export interface RideOrderListItem {
  order_id: string;
  ride_id: string;
  status: string;
  vehicle_class: string;
  /** true = scheduled/airport, false = realtime. */
  is_scheduled: boolean;
  /** ISO 8601 datetime; empty string for realtime orders. */
  scheduled_at: string;
  price_amount: number | null;
  /** Final settled amount; equals price_amount until final-fare settlement runs. */
  final_amount: number | null;
  price_currency: string;
  payment_status: string;
  /** pending | settled | no_adjustment | settlement_pending | not_applicable. */
  final_settlement_status: string;
  /** Cancellation fee (cancelled orders); null otherwise. */
  cancellation_fee: number | null;
  provider: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ListOrdersResponse {
  orders: RideOrderListItem[];
  total: number;
  page: number;
  page_size: number;
}

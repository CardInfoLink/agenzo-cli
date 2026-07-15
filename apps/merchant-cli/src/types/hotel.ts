// ============================================================
// merchant-cli (hotel-redaug) business response types
// ============================================================
//
// Response shapes owned by merchant-cli, modeled on the LIVE platform hotel
// responses (services/merchant_service/hotel/services/order_mapping.py +
// hotel_service.py), NOT the capability schema where they diverge. They live
// here (not in @agenzo/cli-core) because only merchant-cli consumes them — per
// the monorepo convention, cross-CLI types go in cli-core, single-app business
// types stay in their owning app.
//
// Three reconciliations against the capability schema (verified against live code):
//   1. `order_status` is the std STRING (PROCESSING|CONFIRMED|CANCELLED|COMPLETED|
//      INIT) on the wire; the integer code (2/3/4/5) rides alongside as
//      `order_status_code` on the provider path only. There is no
//      `order_status_std` field.
//   2. `cancel` returns either the confirmed shape (`cancellation`,
//      `cancellation_fee`, `refund_amount`) or the accepted-but-pending shape
//      (`cancel_status`, `cancel_result`). Both are modeled below.
//   3. `checkout` returns `{ order_id, task_order_code, apply_status,
//      checkout_status }` — not the schema's `{cancel_result, penalty, refund}`.
//
// Monetary amounts are decimals in the currency's standard unit (e.g. 320.50 CNY),
// paired with a currency code — NEVER minor units.

// ---- search ----  (provider passthrough; rendered as hotels[])

export interface HotelLowestPrice {
  amount: number;
  currency: string;
}

export interface HotelSummary {
  hotel_id: string | number;
  hotel_name: string;
  star?: number | null;
  address?: string | null;
  distance_km?: number | null;
  lowest_price?: HotelLowestPrice | null;
  // Addendum A — enriched search response fields
  city_name?: string | null;
  district_name?: string | null;
  business_name?: string | null;
  score?: number | null;
  main_image?: string | null;
}

export interface SearchHotelResponse {
  hotels: HotelSummary[];
}

// ---- quote ----  (provider passthrough; rendered as rates[])

/**
 * Per-night price breakdown, echoed from quote and passed back to `book`
 * verbatim. `sale_price` is a decimal currency amount (never minor units).
 * Doubles as the parsed-flag intermediate type for `book --price-items`.
 */
export interface PriceItem {
  sale_date: string;
  sale_price: number;
  breakfast_num: number;
}

export interface HotelMoney {
  amount: number;
  currency: string;
}

export interface HotelRate {
  product_token: string;
  room_name: string;
  rate_plan_name?: string | null;
  breakfast?: number | null;
  free_cancellation?: boolean | null;
  total_price: HotelMoney;
  price_items: PriceItem[];
}

export interface QuoteHotelResponse {
  rates: HotelRate[];
}

// ---- book / create-order ----  (order_mapping.format_book / format_create_order)

export interface BookedRoom {
  room_index: string;
  guest_name: string;
}

export interface BookHotelResponse {
  order_id: string;
  fc_order_code: string;
  /** Wire is the std STRING, typically "PROCESSING" — poll `get` until CONFIRMED. */
  order_status: string;
  pay_status?: string | null;
  rooms: BookedRoom[];
  price?: HotelMoney;
  /** "ON_ACCOUNT" (monthly_settlement). */
  payment_status: string;
  /** "redaug". */
  provider: string;
  billing_entry_id?: string;
}

// ---- create-order ----  (create-then-pay step 1: lock inventory, no charge)

export interface CreateHotelOrderResponse {
  order_id: string;
  fc_order_code: string;
  order_status: string;
  total_amount: number;
  currency: string;
  rooms?: BookedRoom[];
}

// ---- pay-order ----  (create-then-pay step 2: settle the order)

export interface PayHotelOrderResponse {
  order_id: string;
  order_status: string;
  settlement_path?: string;
  pay_status?: string;
  total_amount?: number;
  currency?: string;
  billing_entry_id?: string;
  merchant_trans_id?: string;
  [key: string]: unknown;
}

// ---- get ----  (order_mapping.format_provider_status / format_local_status)

/** Guest name persisted at create-order time (`{name: guest_name}` on the wire). */
export interface HotelOrderGuest {
  name?: string | null;
}

/** Booking contact persisted at create-order time. */
export interface HotelOrderContact {
  name?: string | null;
  phone?: string | null;
  country_code?: string | null;
  email?: string | null;
}

export interface GetHotelOrderResponse {
  order_id: string;
  fc_order_code: string;
  /** Std STRING: PROCESSING | CONFIRMED | CANCELLED | COMPLETED | INIT. */
  order_status: string;
  /** Integer 2/3/4/5 — provider path only; absent on the local-cache fallback. */
  order_status_code?: number;
  channel_state?: string | null;
  hotel_confirm_no?: string | null;
  hotel_name?: string | null;
  room_name?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  total_amount?: number | null;
  /** Currency for `total_amount`, sourced from the local record on both paths. */
  currency?: string | null;
  /** Present on the local-cache fallback path (format_local_status). */
  price?: HotelMoney | null;
  /** Room/guest assignment persisted at create-order time. */
  rooms?: BookedRoom[] | null;
  /** "monthly_settlement" | "pay_per_call" — set once pay-order settles. */
  settlement_path?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // ---- booking detail shown on an order confirmation (persisted at create-order) ----
  guest?: HotelOrderGuest | null;
  contact?: HotelOrderContact | null;
  room_num?: number | null;
  arrive_time?: string | null;
  special_requests?: string | null;
}

// ---- cancel ----  (format_cancel / format_cancel_pending)

export interface HotelCancellation {
  cancellation_fee?: number;
  reversal_amount?: number;
  currency?: string;
  [k: string]: unknown;
}

export interface CancelHotelResponse {
  order_id: string;
  order_status: string;
  // confirmed shape
  cancellation?: HotelCancellation | null;
  cancellation_fee?: number | null;
  refund_amount?: number;
  // accepted-but-pending shape
  /** "cancel_pending" when accepted upstream but not yet observed as CANCELLED. */
  cancel_status?: string;
  /** Upstream cancel acknowledgement (pending case). */
  cancel_result?: unknown;
}

// ---- checkout ----  (hotel_service.checkout)

export interface CheckoutHotelResponse {
  order_id: string;
  task_order_code: string;
  apply_status?: string | null;
  /** "checkout_pending" — async; poll `get-checkout`. */
  checkout_status?: string;
}

// ---- get-checkout ----  (provider passthrough)

export interface GetCheckoutResponse {
  task_order_code: string;
  /** pending | approved | rejected | refunded. */
  refund_status: string;
  refund?: HotelMoney | null;
}

// ---- list-orders ----  (order_mapping.format_list_item)

export interface HotelOrderListItem {
  order_id: string;
  fc_order_code: string;
  status: string;
  provider: string;
  check_in?: string | null;
  check_out?: string | null;
  room_num?: number | null;
  price_amount?: number | null;
  price_currency: string;
  payment_status: string;
  hotel_confirm_no?: string | null;
  cancellation_fee?: number | null;
  refund_amount?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ListHotelOrdersResponse {
  orders: HotelOrderListItem[];
  total: number;
  page: number;
  page_size: number;
}

// ---- parsed-flag intermediate models (pure builders) ----
//
// `--price-items` (book) and `--checkout-rooms` (checkout) are parsed and
// shape-validated by pure functions before body assembly. `PriceItem` (above)
// is the parsed type for `--price-items`; `CheckoutRoom` is the parsed type for
// `--checkout-rooms`.

export interface CheckoutRoom {
  room_index: string;
  guest_name: string;
  cancel_check_in_date: string;
}

// ---- find-destination ----  (provider passthrough; rendered as destinations[])

export interface Destination {
  destination_id: string | null;
  type?: string | number | null;
  name?: string | null;
  city_name?: string | null;
  city_code?: string | null;
  country_name?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface FindDestinationResponse {
  destinations: Destination[];
}

// ---- hotel-filters ----  (provider passthrough; rendered as grouped filter lists)

export interface FilterOption {
  code: string | number;
  name: string;
  count?: number | string;
}

export interface FacilityOption extends FilterOption {
  type?: number | null;
}

export interface HotelFiltersResponse {
  /** code → search --star */
  stars: FilterOption[];
  /** code → search --hotel-brand-codes */
  brands: FilterOption[];
  groups: FilterOption[];
  /** code → search --hotel-label-ids */
  labels: FilterOption[];
  /** code → search --hotel-sub-category-ids */
  sub_categories: FilterOption[];
  /** code → search --hotel-facility-codes */
  hotel_facilities: FacilityOption[];
  /** code → search --room-facility-codes */
  room_facilities: FacilityOption[];
}

// ---- list-cities ----  (provider passthrough; rendered as cities[])

export interface CityItem {
  city_code: string;
  city_name: string;
  /** → search --destination-id */
  destination_id?: string | null;
  province_code?: string | null;
  province_name?: string | null;
  country_code?: string | null;
  country_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  time_zone?: string | null;
  popularity_score?: number | null;
}

export interface ListCitiesResponse {
  cities: CityItem[];
}

// ---- hotel-detail ----  (provider passthrough; rendered as single hotel object)

export interface HotelFacility {
  name: string;
  type?: string | null;
}

export interface HotelImage {
  url: string;
  is_main: boolean;
  type?: number | null;
}

export interface HotelRoomBed {
  name?: string | null;
  width?: string | null;
  num?: string | null;
}

/**
 * Static room-type info (area/floor/beds/max occupancy/images) from
 * queryHotelInfo.roomInfos + queryHotelImage.roomImages. `room_id` is the
 * SAME id space as quote's `roomItems[].roomId` — use it to relate a room's
 * static description (this) to its live rate/product_token (quote).
 * NOT a live rate: no price or availability here — always quote for that.
 */
export interface HotelRoom {
  room_id: number | string | null;
  room_name?: string | null;
  /** Room area, upstream unit (commonly m^2), as a string. */
  area_sqm?: string | null;
  floor?: string | null;
  max_person?: number | null;
  max_adults?: number | null;
  max_child?: number | null;
  allow_smoking?: boolean | null;
  beds: HotelRoomBed[];
  living_room_beds: HotelRoomBed[];
  /** Empty when --with-images false. */
  images: HotelImage[];
}

/** Guest review score for one channel (only present when --settings included 'comment'). */
export interface HotelComment {
  channel?: string | null;
  average_score?: number | null;
}

/** Business certificate/qualification (only present when --settings included 'hotelCertificates'). */
export interface HotelCertificate {
  unify_code?: string | null;
  certification_name?: string | null;
  file_url?: string | null;
}

/**
 * Free-text hotel policy keyed by code (hotelPolicy/instructions/specialInstructions/
 * mandatoryFees/optionalFees/cleanAndSafety/importantNotices/ageLimit/checkInCheckOut).
 * Only present when --settings included 'hotelTextPolicies'.
 */
export interface HotelTextPolicy {
  code?: string | null;
  code_name?: string | null;
  text?: string | null;
}

/** Raw upstream structured child/extra-bed/pet policies, snake_cased (shape not modeled deeper). */
export interface HotelStructuredPolicies {
  child_policy?: Record<string, unknown> | null;
  extra_bed_policy?: Record<string, unknown> | null;
  pet_policy?: Record<string, unknown> | null;
}

export interface HotelDetailResponse {
  hotel_id: string | number;
  hotel_name?: string | null;
  hotel_eng_name?: string | null;
  star?: number | null;
  address?: string | null;
  intro?: string | null;
  appearance_image?: string | null;
  telephone?: string | null;
  country_name?: string | null;
  province_name?: string | null;
  city_name?: string | null;
  district_name?: string | null;
  business_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  check_in_time?: string | null;
  check_out_time?: string | null;
  room_num?: number | null;
  facilities: HotelFacility[];
  /** Empty when --with-images false. */
  images: HotelImage[];
  /** Room types with static info (area/floor/beds/occupancy/images). */
  rooms: HotelRoom[];
  /** Empty unless --settings included 'comment'. */
  comment?: HotelComment[];
  /** Empty unless --settings included 'hotelCertificates' (property may simply have none). */
  hotel_certificates?: HotelCertificate[];
  /** Empty unless --settings included 'hotelTextPolicies'. */
  hotel_text_policies?: HotelTextPolicy[];
  /** null unless --settings included the relevant hotelStructuredPolicies.* code(s). */
  hotel_structured_policies?: HotelStructuredPolicies | null;
  /**
   * IMPORTANT — the property's "special check-in instructions" (upstream code
   * specialInstructions, distinct from the general "instructions" code). MUST be
   * surfaced to the user in the booking UI when present: the upstream data
   * provider does not accept liability for booking issues caused by this not
   * being displayed. Only populated when --settings included 'hotelTextPolicies';
   * null otherwise (does NOT mean the hotel has none — means it wasn't requested).
   */
  special_instructions?: string | null;
}

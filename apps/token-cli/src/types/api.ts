// ============================================================
// token-cli business response types
// ============================================================
//
// Response shapes owned by token-cli. They live here (not in @agenzo/cli-core)
// because only token-cli consumes them — per the monorepo convention, cross-CLI
// types go in cli-core, single-app business types stay in their owning app.

// ---- Payment Method ----

export interface PaymentMethod {
  id: string;
  type: string;
  brand?: string;
  first6?: string;
  last4?: string;
  status: string;
  magic_link_token?: string;
  expires_at?: string;
  created_at: string;
  /** Payment brand: 'evo' (default, existing 3DS/Drop-in binding) | 'unionpay'. */
  payment_brand?: string;
  /** UnionPay only: present when payment_brand === 'unionpay' and status === 'PENDING'. */
  enroll_url?: string;
  /** UnionPay only: enrollment correlation id, present when payment_brand === 'unionpay'. */
  correlation_id?: string;
  /** The end-user member id this payment method belongs to (set at enrollment). */
  member_id?: string | null;
}

// ---- Drop-in session (payment-methods add --mode dropin) ----

/**
 * Response from `POST /payment-methods/dropin/create`.
 *
 * In dropin mode the CLI mints a Drop-in session instead of collecting
 * card details itself; the payment method is created in PENDING state and
 * activated by the developer's own front-end (which embeds the add-payment
 * UI initialised with `session_id`). The CLI then polls
 * `/payment-methods/verification/status` by `id` until a terminal status.
 */
export interface DropinCreateResponse {
  /** Payment method id, e.g. "pm_xxxxx" — poll verification/status by this. */
  id: string;
  /** Session id used by the front-end SDK to render the add-payment UI. */
  session_id: string;
  /** Upstream merchant transaction id, format T{y}{MMddHHmmss}{rand3}. */
  merchant_trans_id: string;
  /** Always "PENDING" on creation. */
  status: string;
}

// ---- Revoke result ----

export interface RevokeResult {
  id: string;
  status: string;
  revoked_at?: string;
  expires_at?: string;
  message?: string;
}

// ---- Payment Tokens (logical display models; commands read via Record) ----

export interface VcnToken {
  id: string;
  type: 'vcn';
  card_number: string;
  expiry: string;
  cvc: string;
  last_four: string;
  amount_limit: number;
  currency: string;
  status: string;
}

export interface NetworkToken {
  id: string;
  type: 'network_token';
  brand: string;
  eci: string;
  cryptogram: string;
  expiry: string;
  value: string;
}

export interface X402Token {
  id: string;
  type: 'x402';
  status: string;
  signature_value: string;
}

export type PaymentToken = VcnToken | NetworkToken | X402Token;

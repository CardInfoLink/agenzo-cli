// ============================================================
// admin-cli business response types
// ============================================================
//
// Response shapes owned by admin-cli. They live here (not in @agenzo/cli-core)
// because only admin-cli consumes them — per the monorepo convention, cross-CLI
// types go in cli-core, single-app business types stay in their owning app.

// ---- Auth ----

export interface MagicLinkStatusResponse {
  status: 'PENDING' | 'CONSUMED' | 'EXPIRED';
  access_token?: string;
  refresh_token?: string;
  org_id?: string;
  org_name?: string;
  access_token_expires_at?: number;
  refresh_token_expires_at?: number;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  access_token_expires_at?: number;
  expires_at?: string; // ISO string from backend
}

// ---- Organization ----

export interface Organization {
  id: string;
  name: string;
  email: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// ---- Developer ----

export interface Developer {
  id: string;
  organization_id?: string;
  name: string;
  email: string;
  status: string;
  billing_mode?: string; // pay_per_call | monthly_settlement
  created_at: string;
  updated_at: string;
}

// ---- Settlement Account ----

export interface SettlementAccount {
  id: string;
  developer_id: string;
  organization_id?: string;
  balance: string; // minor currency units (e.g. cents), serialized as a string to avoid precision loss
  currency: string;
  status: string; // active | suspended | closed
  created_at: string;
  updated_at: string;
}

// ---- API Key ----

export interface ApiKey {
  id: string;
  developer_id: string;
  name: string;
  api_key?: string; // Full key value, only returned on create/rotate
  key_prefix: string;
  scope?: string[]; // CLIs this key may call: subset of token / merchant / payment
  status: string;
  last_used_at?: string | null;
  created_at: string;
}

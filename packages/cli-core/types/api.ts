// ============================================================
// Shared cross-CLI response types
// ============================================================
//
// cli-core only holds types used by MORE THAN ONE CLI. Single-CLI business
// response types live in their owning app (apps/<cli>/src/types/api.ts).
//
// `DisableResult` is the lone survivor here: it is consumed by both admin-cli
// (`keys disable`) and token-cli (`payment-methods disable`).

export interface DisableResult {
  status: string;
  revoked_tokens_count?: number;
}

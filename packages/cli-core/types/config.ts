export interface AppConfig {
  active_org: string | null;
  active_developer_id: string | null;
  api_host: string;
  api_path: string;
}

export interface OrgCredential {
  org_id: string;
  org_name: string;
  email: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: number; // Unix timestamp (seconds)
  refresh_token_expires_at: number;
  api_host?: string; // The host this credential was created against
}

export interface StoredApiKey {
  key_id: string;
  developer_id: string;
  name: string;
  key_value: string; // Full key value, written only on create
  created_at: string;
}

export interface KeyStoreData {
  [orgId: string]: StoredApiKey[];
}

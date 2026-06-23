import { NetworkError, UpgradeRequiredError } from '../errors/errors.js';
import { getCurrentVersion, isBelow, UPGRADE_COMMAND } from '../version/version.js';

export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number; // Default 30000ms
}

export interface ApiResponse<T> {
  success: true;
  data: T;
  /** Server-provided message from the unified response envelope. */
  message?: string;
}

/** Upstream error details (diagnostic only, not stable). */
export interface UpstreamError {
  /** Upstream-specific error code (stringified). */
  code: string;
  /** Upstream-specific error message. */
  message: string;
}

export interface ApiError {
  success: false;
  errorCode: number;
  errorMessage: string;
  statusCode: number;
  /**
   * Raw string code from the v3 response envelope (`{ code, message, data }`),
   * surfaced verbatim so {@link CliError.fromApi} can route domain-specific
   * §8 codes (e.g. `QUOTE_EXPIRED`, `VEHICLE_UNAVAILABLE`) by string code
   * before falling back to HTTP-status mapping. Absent when the backend does
   * not provide a string code (e.g. non-JSON error responses).
   */
  code?: string;
  /** Server-provided request correlation id, surfaced in the error envelope. */
  requestId?: string;
  /** Upstream error details for diagnostic transparency. */
  upstream?: UpstreamError;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

export type AuthMode =
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; key: string }
  | { type: 'none' };

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeout = config.timeout ?? 60000;
  }

  private buildHeaders(auth: AuthMode): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': `agenzo-admin-cli/${getCurrentVersion()}`,
    };
    if (auth.type === 'bearer') {
      headers['Authorization'] = `Bearer ${auth.token}`;
    } else if (auth.type === 'api-key') {
      headers['X-Api-Key'] = auth.key;
    }
    return headers;
  }

  async get<T>(
    path: string,
    auth: AuthMode,
    params?: Record<string, string>,
  ): Promise<ApiResult<T>> {
    let url = `${this.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }
    return this.request<T>(url, {
      method: 'GET',
      headers: this.buildHeaders(auth),
    });
  }

  async post<T>(
    path: string,
    auth: AuthMode,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(auth);
    headers['Content-Type'] = 'application/json';
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }
    return this.request<T>(url, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      // Enforce server-advertised CLI version floor before doing any work
      // on the response. Throws UpgradeRequiredError which is rendered and
      // exits at the top level (src/index.ts).
      this.enforceMinVersion(response.headers.get('x-cli-min-version'));

      // Handle non-JSON responses (e.g. 500 Internal Server Error returns plain text)
      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: Record<string, unknown>;
      if (contentType.includes('application/json')) {
        responseBody = await response.json() as Record<string, unknown>;
      } else {
        const text = await response.text();
        if (!response.ok) {
          const statusMsg = this.friendlyStatusMessage(response.status);
          return {
            success: false,
            errorCode: 0,
            errorMessage: statusMsg,
            statusCode: response.status,
          };
        }
        // Try parsing as JSON anyway (some servers don't set content-type)
        try {
          responseBody = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return {
            success: false,
            errorCode: 0,
            errorMessage: `Unexpected response from server (${response.status})`,
            statusCode: response.status,
          };
        }
      }

      // Server uses unified format: { code: "0000", message: "...", data: {...} }
      const code = responseBody.code as string | undefined;
      const message = responseBody.message as string | undefined;

      // Success: HTTP 2xx AND code is "0000" (or no code field for raw responses)
      if (response.ok && (!code || code === '0000')) {
        // If the server wraps the payload in a "data" field, unwrap it —
        // including when `data` is explicitly null (a valid empty payload,
        // e.g. GET /accounts for a developer without a settlement account).
        // We must distinguish "no data field" (raw response → use the whole
        // body) from "data field present but null" (→ return null), since
        // `data ?? responseBody` would wrongly fall back to the envelope and
        // surface { code, message, data: null } as the payload.
        const hasDataField = Object.prototype.hasOwnProperty.call(responseBody, 'data');
        const payload = hasDataField ? responseBody.data : responseBody;
        return { success: true, data: payload as T, message };
      }

      // Error: either HTTP non-2xx or code !== "0000"
      const errorCode = code ? parseInt(code, 10) : 0;
      // Handle FastAPI 422 validation errors where detail is an array
      let errorMsg = message ?? response.statusText;
      if (!errorMsg || errorMsg === response.statusText) {
        const detail = responseBody.detail;
        if (Array.isArray(detail)) {
          errorMsg = detail.map((d: Record<string, unknown>) => {
            const loc = (d.loc as string[])?.slice(1).join('.') ?? '';
            return loc ? `${loc}: ${d.msg}` : String(d.msg);
          }).join('; ');
        } else if (typeof detail === 'string') {
          errorMsg = detail;
        }
      }

      // Prefer string error_code (CLI D3 routing) over numeric code string
      const errorCodeStr = responseBody.error_code as string | undefined;

      // Extract upstream error details from data.upstream
      const rawData = responseBody.data as Record<string, unknown> | undefined;
      const upstream = (rawData?.upstream && typeof rawData.upstream === 'object')
        ? rawData.upstream as UpstreamError
        : undefined;

      return {
        success: false,
        errorCode: isNaN(errorCode) ? 0 : errorCode,
        errorMessage: errorMsg,
        statusCode: response.status,
        ...(errorCodeStr ? { code: errorCodeStr } : (typeof code === 'string' && code ? { code } : {})),
        requestId: (responseBody.request_id ?? responseBody.requestId) as string | undefined,
        ...(upstream ? { upstream } : {}),
      };
    } catch (error) {
      // UpgradeRequiredError is a CliError and must propagate untouched to the
      // top-level handler; don't rewrap it as a NetworkError.
      if (error instanceof UpgradeRequiredError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new NetworkError(url, this.timeout);
      }
      throw new NetworkError(url, undefined, error instanceof Error ? error : undefined);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate that the running CLI meets the server-advertised minimum.
   * Missing or empty header → skip (backward compat with servers that don't
   * advertise yet, and clients hitting legacy proxies).
   */
  private enforceMinVersion(headerValue: string | null): void {
    const minVersion = headerValue?.trim();
    if (!minVersion) return;
    const current = getCurrentVersion();
    if (isBelow(current, minVersion)) {
      throw new UpgradeRequiredError(current, minVersion, UPGRADE_COMMAND);
    }
  }

  private friendlyStatusMessage(status: number): string {
    const messages: Record<number, string> = {
      400: 'Invalid request. Please check your input.',
      401: 'Authentication failed. Please check your API key or login again.',
      403: 'Access denied. You do not have permission for this operation.',
      404: 'Resource not found. Please check the ID.',
      409: 'Conflict. This resource may already exist.',
      422: 'Invalid input. Please check the request parameters.',
      429: 'Too many requests. Please wait and try again.',
      500: 'Something went wrong on the server. Please try again later.',
      502: 'Service is temporarily unavailable. Please try again in a moment.',
      503: 'Service is temporarily unavailable. Please try again in a moment.',
      504: 'The request took too long. Please try again.',
    };
    return messages[status] ?? `Something went wrong (${status}). Please try again later.`;
  }
}

import { NetworkError, UpgradeRequiredError } from '../errors/errors.js';
import { getCurrentVersion, isBelow, UPGRADE_COMMAND } from '../version/version.js';

/**
 * W3C Trace Context `traceparent` 格式：`<version>-<trace-id>-<parent-id>-<flags>`。
 * 全零 trace-id 按规范无效，由下游解析时一并拒绝。
 */
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * HTTP 超时默认值（毫秒）。可被构造参数或 AGENZO_CLI_HTTP_TIMEOUT_MS 覆盖。
 *
 * 这个值是跨服务超时阶梯的一层，不能单独调：
 *   App 120s > orchestrator 90s > **本项 70s** > provider 45s > ledger 5s
 * 每层都要比下一层留出余量，好让下游的结构化错误有机会回传上来；两层取同值会导致
 * 上游在下游写出错误原因之前就放弃。完整依据见 platform 仓
 * docs/00-平台设计文档/01-跨仓文档/16-信任边界与超时预算设计.md。
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 70000;

/**
 * 从环境变量读 HTTP 超时；缺失或非法（非数字、<=0）时返回 null 交由调用方回落默认值。
 *
 * CLI 通常是被 orchestrator spawn 的子进程，环境变量是最自然的注入口——与
 * TRACEPARENT 走同一条路。这也是递减 deadline 的前置：上游要能按剩余预算
 * 压缩本跳超时，就必须有地方把值传进来。
 */
export function httpTimeoutFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.AGENZO_CLI_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** 递减 deadline 的 HTTP 头名（剩余毫秒）。与 py-commons 的 DEADLINE_HEADER 对齐。 */
export const DEADLINE_HEADER = 'x-deadline-ms';

/**
 * 出站前为回程预留的毫秒数：下游返回后本进程还要解析 JSON、渲染输出、写回 stdout。
 * 与 py-commons 的 DEFAULT_RESERVE_MS 取同值，六仓对"预留多少"保持一致。
 */
export const DEADLINE_RESERVE_MS = 200;

/**
 * 从环境变量读上游给的剩余预算（毫秒）；缺失或非法时返回 null。
 *
 * orchestrator spawn 本进程时经 DEADLINE_MS 注入（见其 backend_gateway/universal.py），
 * 与 TRACEPARENT 同一机制。不接受浮点串——协议规定整数毫秒，容忍浮点会让不同语言的
 * 实现出现取整分歧。
 */
export function deadlineFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.DEADLINE_MS;
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export interface ApiClientConfig {
  baseUrl: string;
  /**
   * HTTP 超时（毫秒）。优先级：本字段 > AGENZO_CLI_HTTP_TIMEOUT_MS > 60000。
   *
   * 显式传值优先于环境变量，这样调用方能对单个 client 做例外（如长轮询），
   * 不受进程级设置牵连。
   */
  timeout?: number;
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
  /**
   * Correlation id for this CLI invocation. Generated once per `ApiClient`
   * instance (i.e. once per command execution — each `apps/*` entrypoint
   * constructs exactly one `ApiClient` per process run) and sent as
   * `X-Request-Id` on every request this client makes. The backend's
   * `RequestIdMiddleware` adopts a client-supplied `X-Request-Id` verbatim as
   * both `trace_id` and `request_id` (only generating its own when the header
   * is absent), so every HTTP call belonging to one CLI operation — including
   * multi-step flows like `payment-methods add`'s create + poll + get — shares
   * a single trace_id server-side and can be followed as one chain in logs.
   */
  private readonly requestId: string;
  /**
   * 上游给的剩余预算（毫秒），来自 `DEADLINE_MS`；未注入时为 null。
   *
   * 进程启动时读一次而不是每请求读：一次 CLI 调用就是链路上的一跳，预算属于这一跳
   * 整体。每请求重读会让多步流程（如 `payment-methods add` 的 create + poll + get）
   * 各自拿到完整预算，等于凭空放大了本跳的时间上限。
   */
  private readonly deadlineMs: number | null;
  /** 本进程开始时刻（单调时钟），用于算已用时间。 */
  private readonly startedAt: number;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.deadlineMs = deadlineFromEnv();
    this.startedAt = performance.now();
    // 超时优先级：显式传参 > AGENZO_CLI_HTTP_TIMEOUT_MS > 默认值，再由剩余预算收紧。
    // 预算只能压小不能放大——它代表上游还愿意等多久，本跳没有权限超出。
    const configured = config.timeout ?? httpTimeoutFromEnv() ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.timeout =
      this.deadlineMs === null
        ? configured
        : Math.min(configured, Math.max(1, this.deadlineMs - DEADLINE_RESERVE_MS));
    this.requestId = crypto.randomUUID();
  }

  /** 交给下游的剩余毫秒：扣掉本进程已用时间与回程预留；无预算时返回 null。 */
  private remainingDeadlineMs(): number | null {
    if (this.deadlineMs === null) return null;
    const elapsed = performance.now() - this.startedAt;
    return Math.max(0, Math.round(this.deadlineMs - elapsed - DEADLINE_RESERVE_MS));
  }

  private buildHeaders(auth: AuthMode): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': `agenzo-admin-cli/${getCurrentVersion()}`,
      'X-Request-Id': this.requestId,
    };
    // 递减 deadline：把扣除本进程已用时间后的剩余量传给 platform，它再往下传给
    // provider / ledger。每一跳都只能收紧，链路末端因此不会超出 App 的等待上限。
    // 已耗尽时仍然发（值为 0），让下游能立刻返回 DEADLINE_EXCEEDED 而不是白跑一趟。
    const remaining = this.remainingDeadlineMs();
    if (remaining !== null) {
      headers[DEADLINE_HEADER] = String(remaining);
    }
    // 续链上游 trace：orchestrator 以子进程方式调用 CLI 时，把 W3C traceparent 放在
    // TRACEPARENT 环境变量里（见 orchestrator app/backend_gateway/universal.py）。
    // 不转发的话 platform 只能看到本进程自生成的 X-Request-Id，链路在 CLI 这里断开。
    // 格式非法时不发，避免把脏值写进下游 trace_id。
    const traceparent = process.env.TRACEPARENT;
    if (traceparent && TRACEPARENT_PATTERN.test(traceparent.trim())) {
      headers['traceparent'] = traceparent.trim();
    }
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

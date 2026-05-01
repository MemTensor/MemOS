/**
 * REST client for the MemOS viewer.
 *
 * Wraps `fetch` with:
 *   - sensible defaults (JSON content-type, API-key propagation),
 *   - uniform error handling (surface `{error:{code,message}}` shape),
 *   - tiny helper surface: `get`, `post`, `del`.
 */

const DEFAULT_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
};

/**
 * URL-path prefix for this viewer — `"/openclaw"` or `"/hermes"` when
 * the hub is serving multiple agents on the same port, `""` when
 * the viewer is mounted at root (legacy single-agent install).
 *
 * Computed once at module load by looking at the first path segment.
 * Route hashes (`#/memories`) are irrelevant — we care only about
 * the real HTTP path the hub routes on.
 */
export const AGENT_PREFIX: string = detectAgentPrefix();

function detectAgentPrefix(): string {
  if (typeof location === "undefined") return "";
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return seg === "openclaw" || seg === "hermes" || seg === "memos" ? `/${seg}` : "";
}

/**
 * Prepend the agent prefix to any API path that starts with
 * `/api/v1`. Leaves other paths untouched so callers can still pass
 * absolute URLs (e.g. the `/api/v1/hub/register` ping which is
 * always hub-scoped).
 */
export function withAgentPrefix(path: string): string {
  if (!AGENT_PREFIX) return path;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith(AGENT_PREFIX + "/")) return path;
  if (path.startsWith("/api/")) return AGENT_PREFIX + path;
  return path;
}

function apiKeyHeader(): Record<string, string> {
  const key = localStorage.getItem("memos.apiKey");
  return key ? { "x-api-key": key } : {};
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public payload?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(withAgentPrefix(path), {
    method,
    headers: { ...DEFAULT_HEADERS, ...apiKeyHeader() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const err =
      payload && typeof payload === "object" && "error" in (payload as any)
        ? (payload as any).error
        : { code: "http_error", message: res.statusText };
    throw new ApiError(err.code, err.message, res.status, payload);
  }
  return payload as T;
}

async function blobRequest(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const res = await fetch(withAgentPrefix(path), {
    method: "GET",
    headers: { ...apiKeyHeader() },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new ApiError("http_error", res.statusText, res.status);
  }
  return res.blob();
}

async function postRaw<T = unknown>(
  path: string,
  body: FormData | Blob,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  // NOTE: we deliberately don't set `content-type` — the browser sets
  // the correct boundary for FormData, and a manual content-type would
  // break multipart parsing on the server side.
  const res = await fetch(withAgentPrefix(path), {
    method: "POST",
    headers: { ...apiKeyHeader() },
    body,
    signal: opts.signal,
  });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const err =
      payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)
        ? (payload as { error: { code: string; message: string } }).error
        : { code: "http_error", message: res.statusText };
    throw new ApiError(err.code, err.message, res.status, payload);
  }
  return payload as T;
}

export const api = {
  get: <T = unknown>(path: string, opts?: { signal?: AbortSignal }) =>
    request<T>("GET", path, undefined, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    request<T>("POST", path, body, opts),
  patch: <T = unknown>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    request<T>("PATCH", path, body, opts),
  del: <T = unknown>(path: string, opts?: { signal?: AbortSignal }) =>
    request<T>("DELETE", path, undefined, opts),
  blob: (path: string, opts?: { signal?: AbortSignal }) => blobRequest(path, opts),
  postRaw: <T = unknown>(
    path: string,
    body: FormData | Blob,
    opts?: { signal?: AbortSignal },
  ) => postRaw<T>(path, body, opts),
};

const DEBUG = ["1", "true", "yes"].includes(String(process.env.DEBUG ?? "").toLowerCase());

export class ApiError extends Error {
  constructor(
    public platform: string,
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `${platform} API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function withQuery(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** fetch + JSON parsing + retries on 429/5xx with exponential backoff. */
export async function request<T = any>(platform: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const fullUrl = withQuery(url, opts.query);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(fullUrl, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // keep raw text
    }
    if (res.ok) return parsed as T;
    if (attempt < retries && RETRYABLE.has(res.status)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (DEBUG) {
      const safeUrl = fullUrl.replace(/(access_token|appsecret_proof|secret)=[^&]+/g, "$1=***");
      console.error(`[${platform}] ${res.status} ${safeUrl}`, text.slice(0, 2000));
    }
    throw new ApiError(platform, res.status, parsed);
  }
}

/**
 * Caches access tokens obtained from a refresh token (Google, Microsoft, LinkedIn).
 * Concurrent callers share one in-flight refresh.
 */
export class TokenCache {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;

  constructor(private readonly fetcher: () => Promise<{ access_token: string; expires_in?: number }>) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (!this.inflight) {
      this.inflight = this.fetcher()
        .then((r) => {
          this.token = r.access_token;
          this.expiresAt = Date.now() + (r.expires_in ?? 3600) * 1000;
          return r.access_token;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }
}

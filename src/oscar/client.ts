import type { ResponseCache } from './cache.js';
import type { Params } from './endpoints.js';
import { OscarUpstreamError } from './errors.js';

export { OscarUpstreamError };

export const USER_AGENT =
  'mcp.example.com MCP (personal in-network provider lookup; +https://mcp.example.com)';

/** Cache lifetimes. The directory changes on the order of weeks, so these are long by design. */
export const TTL = {
  SPECIALTY: 30 * 24 * 60 * 60 * 1000,
  NETWORK: 30 * 24 * 60 * 60 * 1000,
  SEARCH: 7 * 24 * 60 * 60 * 1000,
  /** Provider detail is the operator's verification step before acting — always live. */
  NONE: 0
} as const;

export interface GetResult<T> {
  body: T;
  /** Epoch ms when this body was cached, or null if freshly fetched. */
  cachedAt: number | null;
}

export interface ClientOptions {
  /** Minimum gap between upstream requests. Politeness throttle, not a rate limiter. */
  minIntervalMs?: number;
}

function queryString(params: Params): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

/**
 * Oscar returns validation errors with `user_message` as an OBJECT keyed by
 * field, e.g. {"sort": ["Not a valid choice."]} — not a string. Interpolating
 * it directly yields "[object Object]" and discards the only part that says
 * what was actually wrong, leaving the model unable to correct its own call.
 */
function describeUpstreamError(body: unknown, statusText: string): string {
  const b = body as { user_message?: unknown; error?: unknown } | null;
  const um = b?.user_message;

  if (typeof um === 'string' && um.trim()) return um;
  if (um && typeof um === 'object') {
    const parts = Object.entries(um as Record<string, unknown>)
      .map(([field, detail]) => `${field}: ${Array.isArray(detail) ? detail.join(' ') : String(detail)}`)
      .filter(p => p.trim().length > 0);
    if (parts.length > 0) {
      const code = typeof b?.error === 'string' ? `${b.error} — ` : '';
      return `${code}${parts.join('; ')}`;
    }
  }
  if (typeof b?.error === 'string' && b.error.trim()) return b.error;
  return statusText;
}

export class OscarClient {
  private readonly baseUrl: string;
  private readonly cache: ResponseCache;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  /**
   * Serialises throttle slot-claiming. Without this the throttle is a no-op for
   * concurrent traffic: every simultaneous caller reads `lastRequestAt` before
   * any of them writes it, so N requests fire at once and only *later* ones are
   * spaced. Chaining through one promise makes each caller wait for the
   * previous to have claimed its slot.
   */
  private throttleChain: Promise<void> = Promise.resolve();
  /** In-flight de-duplication: identical concurrent requests share one fetch. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(baseUrl: string, cache: ResponseCache, opts: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cache = cache;
    this.minIntervalMs = opts.minIntervalMs ?? 400;
  }

  async get<T>(path: string, params: Params, opts: { ttlMs: number; refresh?: boolean }): Promise<GetResult<T>> {
    const qs = queryString(params);
    const key = `${path}?${qs}`;

    if (opts.ttlMs > 0 && !opts.refresh) {
      const hit = this.cache.get(key, opts.ttlMs);
      if (hit) return { body: hit.body as T, cachedAt: hit.cachedAt };
    }

    // A refresh caller is explicitly asking to bypass caching, so it must not
    // join an in-flight request and inherit that request's result — which may
    // have been issued before whatever prompted the refresh. It fetches its own
    // and stays out of the in-flight map entirely.
    if (opts.refresh) {
      const body = await this.fetchFresh(key, qs ? `${path}?${qs}` : path, opts.ttlMs);
      return { body: body as T, cachedAt: null };
    }

    const existing = this.inflight.get(key);
    if (existing) return { body: (await existing) as T, cachedAt: null };

    const promise = this.fetchFresh(key, qs ? `${path}?${qs}` : path, opts.ttlMs);
    this.inflight.set(key, promise);
    try {
      return { body: (await promise) as T, cachedAt: null };
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Drops cache rows older than `maxAgeMs`. Called on a timer by server.ts so
   * the SQLite file does not grow without bound: rows past the longest TTL can
   * never be served again, and nothing else ever deletes them.
   */
  purgeCache(maxAgeMs: number): void {
    this.cache.purgeExpired(maxAgeMs);
  }

  private throttle(): Promise<void> {
    if (this.minIntervalMs <= 0) return Promise.resolve();
    const slot = this.throttleChain.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    });
    // The chain must survive a rejected link, or one failed request would
    // permanently wedge every future one behind it.
    this.throttleChain = slot.catch(() => {});
    return slot;
  }

  private async fetchFresh(key: string, pathWithQuery: string, ttlMs: number): Promise<unknown> {
    await this.throttle();
    const res = await fetch(`${this.baseUrl}${pathWithQuery}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OscarUpstreamError(res.status, `Expected JSON, got ${text.slice(0, 120)}`);
    }

    if (!res.ok) {
      const requestId = (body as { responseContext?: { request_id?: string } })?.responseContext?.request_id;
      const message = describeUpstreamError(body, res.statusText);
      throw new OscarUpstreamError(res.status, message, requestId);
    }

    // Only successful responses are cached — an error must not be served for a week.
    if (ttlMs > 0) this.cache.set(key, body);
    return body;
  }
}

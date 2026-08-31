import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
// a sibling MCP server re-exported the SDK's CallToolResult from its tools/context.ts; this
// project's context.ts does not, and the auth/audit layer is deliberately
// independent of what it protects — so the type comes straight from the SDK.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Key names treated as secret, checked case-insensitively against the OWN key
 * of a field (not its ancestors' keys, not its value). Deliberately broad —
 * this is the one regex standing between a tool argument and a line written
 * to disk forever, so a false positive (an ordinary field redacted) is a cost
 * this codebase is happy to pay; a false negative (a secret logged in the
 * clear) is not.
 *
 *   - token/password/secret          confirmToken, MCP_SESSION_SECRET, password
 *   - apikey / api_key / key$        SOME_API_KEY, apiKey (any casing/separator)
 *   - authorization                  the bearer header, if it ever ends up in an object
 *   - hash                           loginPasswordHash and friends
 *   - verifier / challenge           PKCE codeVerifier / codeChallenge
 *   - ^code$                         the OAuth authorization `code` param, exactly —
 *                                    NOT any field merely ending in "Code" (currencyCode,
 *                                    discountCode, ...), which is common and not secret
 */
const SECRET_KEY = /token|password|secret|api[_-]?key|authorization|key$|hash|verifier|challenge|^code$/i;

/**
 * Deep-clones `value`, replacing every property whose key matches
 * `SECRET_KEY` with the literal string `'[redacted]'`. Recurses into nested
 * objects and arrays at any depth so a secret buried inside e.g.
 * `{ lines: [{ password: '...' }] }` is caught, not just top-level fields.
 * Non-plain values (numbers, strings, null, dates) pass through unchanged.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

export interface AuditEntry {
  tool: string;
  args: unknown;
  status: 'ok' | 'error';
  durationMs: number;
  message?: string;
}

/**
 * Append-only JSON-Lines audit log. One line per tool call (and, separately,
 * per OAuth authorization grant — see OscarOAuthProvider.issueCode).
 *
 * Never throws: a logging failure (disk full, permissions) must not take down
 * a tool call that otherwise succeeded. The failure is still surfaced, via
 * console.error, so it shows up in `pm2 logs` even though it does not reach
 * this file.
 */
export class AuditLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  record(entry: AuditEntry): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try {
      appendFileSync(this.path, line + '\n');
    } catch (e) {
      console.error('audit write failed', e);
    }
  }
}

/**
 * Wraps an already-safe tool handler (one that cannot throw — see
 * `tools/context.ts`'s `guarded`) so every call is timed and recorded.
 * Arguments are redacted before they are written, and the result is passed
 * through unchanged either way — auditing is purely an observer here, never
 * a gate.
 */
export function withAudit<A>(
  log: AuditLog,
  tool: string,
  handler: (args: A) => Promise<CallToolResult>
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const started = Date.now();
    const result = await handler(args);
    const first = result.content[0];
    log.record({
      tool,
      args: redact(args),
      status: result.isError ? 'error' : 'ok',
      durationMs: Date.now() - started,
      message: result.isError && first && 'text' in first ? String(first.text).slice(0, 300) : undefined
    });
    return result;
  };
}

/** Default key: the caller's address, as Express computes it under `trust proxy`. See rateLimit() below for why this must never be a client-supplied header. */
const byIp = (req: Request): string => String(req.ip ?? 'anonymous');

/**
 * Fixed-window request limiter. Each call to this factory owns its own
 * `hits` map, so `rateLimit()` on `/mcp` and a second, separately-configured
 * call on `/login` (see auth/login.ts) never share state or a threshold.
 *
 * Keyed by `req.ip` by default — **never** by a client-supplied header like
 * `Authorization`. This function is mounted ahead of `requireBearerAuth` on
 * `/mcp` (so the value has not been verified yet) and `/login` is pre-auth by
 * definition, so on both call sites a header-based key is attacker-chosen: a
 * client sending a fresh random `Authorization` value on every request gets a
 * fresh bucket every time, which (a) makes the limit itself trivially
 * bypassable and (b) grows `hits` without bound on a value nginx alone permits
 * up to ~8KB per request — unbounded memory growth from an open, unauthenticated
 * endpoint, not just a bypassed limit. `req.ip` is not attacker-controlled here:
 * `trust proxy` is `'loopback'` in server.ts, and nginx's `X-Forwarded-For`
 * config appends rather than replaces, so Express resolves the real peer
 * regardless of what the client sends in that header.
 *
 * A custom `keyFn` is accepted for tests (to simulate distinct source
 * addresses without real sockets) and for a future *second*, post-auth
 * limiter keyed on a verified token for per-caller fairness — never for a
 * pre-auth key sourced from request headers.
 *
 * `hits` is swept on the same cadence as the window so a long-lived process
 * does not accumulate one entry per distinct source forever; the interval is
 * unref'd so it never keeps the process alive on its own.
 */
export function rateLimit(max = 60, windowMs = 60_000, keyFn: (req: Request) => string = byIp) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= max) {
      res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
      return;
    }
    entry.count += 1;
    next();
  };

  // Exposed for tests to assert on directly (map size after a sweep, in
  // particular) — not part of the contract for callers wiring this into an
  // Express app, which only ever use the returned function as middleware.
  middleware.hits = hits;
  return middleware;
}

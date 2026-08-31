import express from 'express';
import argon2 from 'argon2';
import type { AuthStore, Pending } from './store.js';
import type { OscarOAuthProvider } from './provider.js';
import type { Config } from '../config.js';
import { rateLimit } from '../audit.js';

/**
 * How many times a single parked authorization request may be retried after a
 * bad password before it is discarded.
 *
 * Each attempt costs one argon2id verification, which is deliberately expensive
 * — so an unauthenticated POST loop is a cheap way to burn CPU. The SDK already
 * rate-limits `/authorize` (100 requests / 15 min), and every parked request is
 * now worth at most this many verifications, which bounds the total.
 */
export const MAX_LOGIN_ATTEMPTS = 5;

/**
 * Brute-force limiter for POST /login, keyed by source address —
 * `rateLimit()`'s default `keyFn` (see audit.ts), never by a header. This
 * endpoint is pre-auth, so every request header including `Authorization` is
 * attacker-chosen; keying on one (an earlier version of this comment assumed
 * "there is no bearer token pre-auth" and reasoned from that) would let an
 * attacker send a fresh value per attempt and never be throttled at all.
 * Deliberately its own `rateLimit()` instance — a Map independent of the one
 * guarding `/mcp` in server.ts — so a client hammering one endpoint never eats
 * into the other's budget, and so this file has no dependency on how
 * server.ts wires its own limiter.
 *
 * MAX_LOGIN_ATTEMPTS above already bounds retries *per parked request* (an
 * expensive argon2id verification each), which is what stops one authorize
 * flow from being brute-forced. This is the complementary bound *per source*
 * across every request the flow: with a fresh parked id available on every
 * retry (see the re-park logic below), MAX_LOGIN_ATTEMPTS alone does not
 * limit how many parked requests one source can burn through. The operator
 * password is 24 random characters, so brute force is not realistically
 * feasible either way — this is defence in depth, not the only thing
 * standing between an attacker and the password.
 *
 * 30 requests / 15 minutes is generous enough that a legitimate operator who
 * fat-fingers a password once or twice is never the one who hits it; it is
 * still a small, bounded fraction of what an actual guessing attempt would need.
 */
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS_PER_SOURCE = 30;

/** Escape text for interpolation into an HTML attribute or element body. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Clickjacking and sniffing defences for the consent page.
 *
 * `frame-ancestors 'none'` (plus the legacy `X-Frame-Options`) is the important
 * one: without it an attacker can iframe this page under their own chrome and
 * overlay it, so the operator reads the attacker's caption instead of the
 * redirect host we display. That would undo the consent information below.
 */
function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}

/** What the operator is being asked to consent to. Every field is untrusted. */
interface ConsentContext {
  pendingId: string;
  /** The client's registered name, or its id when it registered no name. */
  clientLabel: string;
  /** Host that will receive the authorization code. The load-bearing signal. */
  redirectHost: string;
  redirectUri: string;
}

/**
 * Describe the request in the pending record.
 *
 * `client_name` is deliberately *not* treated as identity: dynamic client
 * registration is open, so anyone can register a client called "ChatGPT". The
 * redirect host is what cannot be forged — it is where the authorization code
 * actually goes — so it is what the page leads with.
 */
function describeConsent(store: AuthStore, pendingId: string, pending: Pending): ConsentContext {
  const client = store.getClient(pending.clientId);
  let redirectHost: string;
  try {
    redirectHost = new URL(pending.redirectUri).host;
  } catch {
    redirectHost = pending.redirectUri;
  }
  return {
    pendingId,
    clientLabel: client?.client_name?.trim() || pending.clientId,
    redirectHost,
    redirectUri: pending.redirectUri
  };
}

const PAGE = (c: ConsentContext, error?: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Oscar Health Provider Search — Authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
 body{font-family:system-ui,sans-serif;background:#f6f7f9;display:flex;min-height:100vh;
      align-items:center;justify-content:center;margin:0;color:#1a1a1a}
 form{background:#fff;padding:2rem;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.12);width:min(400px,92vw)}
 h1{font-size:1.1rem;margin:0 0 .25rem} p.sub{margin:0 0 1rem;color:#666;font-size:.85rem}
 .who{border:1px solid #e3e5e8;border-radius:8px;padding:.85rem;margin:0 0 1rem;background:#fbfcfd}
 .who dt{font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#777;margin:0 0 .15rem}
 .who dd{margin:0 0 .7rem;font-size:.95rem;word-break:break-all}
 .who dd:last-child{margin-bottom:0}
 .host{font-size:1.15rem;font-weight:650;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#0a0a0a}
 .warn{color:#8a5300;font-size:.8rem;margin:.6rem 0 0;line-height:1.35}
 label{display:block;font-size:.8rem;margin:.75rem 0 .25rem;color:#444}
 input{width:100%;padding:.6rem;border:1px solid #ccd;border-radius:6px;font-size:.95rem;box-sizing:border-box}
 button{width:100%;margin-top:1.25rem;padding:.65rem;border:0;border-radius:6px;background:#0b6;color:#fff;
        font-size:.95rem;cursor:pointer}
 .err{background:#fee;color:#900;padding:.55rem;border-radius:6px;font-size:.85rem;margin-bottom:.5rem}
</style></head><body>
<form method="POST" action="/login">
  <h1>Authorize provider search access</h1>
  <p class="sub">Sign in to let this application search the Oscar Health in-network provider directory on your behalf.</p>
  <dl class="who">
    <dt>Your data will be sent to</dt>
    <dd class="host">${escapeHtml(c.redirectHost)}</dd>
    <dt>Application name (self-declared, not verified)</dt>
    <dd>${escapeHtml(c.clientLabel)}</dd>
  </dl>
  <p class="warn">Only continue if you recognise that address. Any application may
  register under any name, so the address above &mdash; not the name &mdash; is what
  tells you where your authorization code is going.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <input type="hidden" name="p" value="${escapeHtml(c.pendingId)}">
  <label for="u">Username</label><input id="u" name="username" autocomplete="username" autofocus>
  <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password">
  <button type="submit">Authorize</button>
</form></body></html>`;

/** A page with no retry form — used when there is nothing to consent to. */
const DEAD_END = (message: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Oscar Health Provider Search — Authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#1a1a1a">
<p>${escapeHtml(message)}</p></body></html>`;

const EXPIRED = 'This sign-in request expired or is unknown. Start again from your MCP client.';

export function createLoginRouter(store: AuthStore, provider: OscarOAuthProvider, config: Config): express.Router {
  const router = express.Router();
  // Scoped to the login routes rather than router.use(): this router is mounted
  // at the app root, so a bare .use() would put a body parser in front of every
  // request the server handles, /mcp included.
  const parseForm = express.urlencoded({ extended: false });
  const loginBruteForceLimit = rateLimit(MAX_LOGIN_ATTEMPTS_PER_SOURCE, LOGIN_ATTEMPT_WINDOW_MS);

  router.get('/login', securityHeaders, (req, res) => {
    const p = String(req.query.p ?? '');
    // peekPending, not takePending: rendering the page must not consume the
    // request, or a reload would break the flow.
    const pending = p ? store.peekPending(p) : undefined;
    if (!pending) {
      res.status(400).type('html').send(DEAD_END(EXPIRED));
      return;
    }
    res.status(200).type('html').send(PAGE(describeConsent(store, p, pending)));
  });

  router.post('/login', securityHeaders, loginBruteForceLimit, parseForm, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = typeof body.p === 'string' ? body.p : '';
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const pending = p ? store.takePending(p) : undefined;
    if (!pending) {
      res.status(400).type('html').send(DEAD_END(EXPIRED));
      return;
    }

    const userOk = username === config.loginUser;
    let passOk = false;
    try {
      passOk = await argon2.verify(config.loginPasswordHash, password);
    } catch {
      passOk = false;
    }

    if (!userOk || !passOk) {
      const attempts = (pending.attempts ?? 0) + 1;
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        // Do not re-park: the request is spent.
        res.status(401).type('html').send(DEAD_END('Too many failed attempts. Start again from your MCP client.'));
        return;
      }
      // Re-park under a fresh id so the operator can retry without restarting
      // the whole flow. The submitted id is already consumed and stays dead.
      const again = store.savePending({ ...pending, attempts } satisfies Pending);
      res
        .status(401)
        .type('html')
        .send(PAGE(describeConsent(store, again, pending), 'Incorrect username or password.'));
      return;
    }

    const code = provider.issueCode(pending);
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    res.redirect(target.toString());
  });

  return router;
}

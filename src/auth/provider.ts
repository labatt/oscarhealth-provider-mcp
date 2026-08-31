import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthStore, Pending } from './store.js';
import type { AuditLog } from '../audit.js';

export interface ProviderOptions {
  /** Where authorize() sends the operator to give consent. */
  loginPath?: string;
  /**
   * Optional hostname allowlist for redirect URIs. See Config.allowedRedirectHosts.
   * Undefined means no restriction; an empty array is treated the same way.
   */
  allowedRedirectHosts?: string[];
  /**
   * When set, every issued authorization code is logged (client name, client
   * id, redirect URI, timestamp) — see issueCode. Optional so existing tests
   * that construct a provider without an audit log keep working; production
   * (server.ts) always supplies one.
   */
  audit?: AuditLog;
}

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 60 * 1000; // 60 seconds

/** Escape text for interpolation into HTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The hostname to add, pulled out so the page can be copied from directly. */
const hostOf = (uri: string) => { try { return new URL(uri).hostname; } catch { return uri; } };

const rejectionPage = (redirectUri: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization refused</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:40rem;color:#1a1a1a">
<h1 style="font-size:1.1rem">Authorization refused</h1>
<p>This application asked to send your authorization code to
<strong>${escapeHtml(redirectUri)}</strong>, which is not on this server's
redirect allowlist. No sign-in page was shown and nothing was authorized.</p>
<p style="color:#666;font-size:.9rem">If you started this yourself and trust the
client, add its callback hostname to <code>MCP_ALLOWED_REDIRECT_HOSTS</code> in
the server's <code>.env</code> and restart:</p>
<pre style="background:#f4f4f4;padding:.6rem .8rem;border-radius:6px;font-size:.9rem;overflow-x:auto"
>MCP_ALLOWED_REDIRECT_HOSTS=${escapeHtml(hostOf(redirectUri))}</pre>
<p style="color:#666;font-size:.9rem">If you did <strong>not</strong> start this,
someone else is trying to have your authorization code sent to a host they
control. Nothing was authorized and no action is needed.</p>
</body></html>`;

/** Length-safe constant-time comparison of two ASCII strings. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, and the lengths of a PKCE
  // challenge are not secret, so comparing them first is safe. Both branches
  // still hash the verifier, so a wrong-length guess is not distinguishable by
  // the cost of the request.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * A self-contained OAuth 2.1 authorization server for this MCP deployment.
 *
 * Notes on how this meets the SDK's `OAuthServerProvider` contract — these are
 * behaviours verified against the installed SDK (v1.30.0) source, not
 * assumptions:
 *
 * - `skipLocalPkceValidation = true`. The SDK's token handler otherwise
 *   validates PKCE itself and then calls `exchangeAuthorizationCode` with
 *   `codeVerifier === undefined`. Taking ownership of the check here means the
 *   verifier is always present at exchange time, so `exchangeAuthorizationCode`
 *   can *require* it — there is no code path in which a code is redeemed
 *   without a proof-of-possession check. The flag's docstring warns it should
 *   only be set when "the upstream server" validates PKCE; here this class *is*
 *   that server, and it does (see `verifyPkce` below).
 *
 * - Every rejection is an SDK `OAuthError` subclass. The handlers translate
 *   `OAuthError` into a 400 with a proper `error` code and anything else into a
 *   500 `server_error`; in particular `requireBearerAuth` only answers 401 when
 *   `verifyAccessToken` throws `InvalidTokenError`.
 */
export class OscarOAuthProvider implements OAuthServerProvider {
  /** See the class docstring: this provider validates PKCE itself. */
  readonly skipLocalPkceValidation = true;

  private readonly loginPath: string;
  private readonly allowedRedirectHosts?: string[];
  private readonly allowAnyRedirectHost: boolean;
  private readonly audit?: AuditLog;

  constructor(
    private store: AuthStore,
    options: ProviderOptions = {}
  ) {
    this.loginPath = options.loginPath ?? '/login';
    this.allowedRedirectHosts = options.allowedRedirectHosts?.length
      ? options.allowedRedirectHosts.map(h => h.toLowerCase())
      : undefined;
    this.allowAnyRedirectHost = this.allowedRedirectHosts?.includes('*') ?? false;
    this.audit = options.audit;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => this.store.getClient(clientId),
      registerClient: async (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        // The SDK's registration handler attaches client_id (and client_secret)
        // before calling this, so the value is already a complete client even
        // though the declared parameter type omits those fields. Narrow to
        // prove it rather than asserting it away.
        const candidate: Partial<OAuthClientInformationFull> = client;
        if (typeof candidate.client_id !== 'string' || candidate.client_id.length === 0) {
          throw new InvalidRequestError('Client registration produced no client_id');
        }
        const full: OAuthClientInformationFull = { ...client, client_id: candidate.client_id };
        this.store.saveClient(full);
        return full;
      }
    };
  }

  /** Park the request and send the operator to the consent page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.redirectHostAllowed(params.redirectUri)) {
      // Answer directly rather than throwing: the SDK turns a thrown OAuthError
      // into a redirect *to the very URI we are refusing to use*, which would
      // hide the reason from the operator. Nothing is parked, so no consent
      // page can ever be shown for this request.
      res
        .status(403)
        .type('html')
        .send(rejectionPage(params.redirectUri));
      return;
    }

    const pendingId = this.store.savePending({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes?.length ? params.scopes : ['mcp'],
      state: params.state,
      resource: params.resource?.href
    });
    res.redirect(`${this.loginPath}?p=${pendingId}`);
  }

  /**
   * Called by the login route once the password checks out.
   *
   * Logs the grant — client name, client id, redirect URI, timestamp — before
   * returning. Task 3 closed a consent-phishing hole where an attacker's
   * dynamically-registered client could be authorized by a spoofed consent
   * page; this is what makes such a grant discoverable after the fact rather
   * than invisible. Logged directly, not through `redact()`: these fields are
   * the evidence a review needs, not secrets to hide from it.
   */
  issueCode(p: Pending): string {
    const code = randomBytes(32).toString('hex');
    this.store.saveCode({ ...p, code, expiresAt: Date.now() + CODE_TTL_MS });
    this.audit?.record({
      tool: 'oauth.authorize_grant',
      args: {
        clientName: this.store.getClient(p.clientId)?.client_name ?? null,
        clientId: p.clientId,
        redirectUri: p.redirectUri
      },
      status: 'ok',
      durationMs: 0
    });
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    // A genuine read: `peekCode` leaves the row in place, so this cannot burn a
    // code, cannot resurrect one, and cannot race a concurrent redemption.
    const record = this.store.peekCode(authorizationCode);
    if (!record) throw new InvalidGrantError('Authorization code not found or expired');
    if (record.clientId !== client.client_id) throw new InvalidGrantError('Authorization code was issued to a different client');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    // Redeem first: `takeCode` deletes unconditionally, so every failure below
    // still burns the code and no amount of retrying gets a second attempt.
    const record = this.store.takeCode(authorizationCode);
    if (!record) throw new InvalidGrantError('Authorization code not found, expired, or already used');
    if (record.clientId !== client.client_id) throw new InvalidGrantError('Authorization code was issued to a different client');
    if (redirectUri !== undefined && record.redirectUri !== redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    if (!codeVerifier) throw new InvalidRequestError('code_verifier is required');
    if (!this.verifyPkce(codeVerifier, record.codeChallenge)) throw new InvalidGrantError('code_verifier does not match the challenge');

    // The flow has now genuinely completed — this is what protects the
    // client's registration from AuthStore's stale-registration pruning from
    // here on (see AuthStore.pruneStaleClients).
    this.store.markClientAuthorized(client.client_id);
    return this.mintTokens(client.client_id, record.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const existing = this.store.getToken(refreshToken);
    if (!existing || existing.kind !== 'refresh') throw new InvalidGrantError('Unknown or expired refresh token');
    if (existing.clientId !== client.client_id) throw new InvalidGrantError('Refresh token belongs to a different client');

    // A refresh may narrow the granted scopes but never widen them (RFC 6749 §6).
    const requested = scopes?.length ? scopes : existing.scopes;
    const widened = requested.filter(s => !existing.scopes.includes(s));
    if (widened.length > 0) throw new InvalidGrantError('Requested scope exceeds the scope of the original grant');

    // Rotate: the presented refresh token is spent whether or not the caller
    // ever uses the replacement.
    this.store.deleteToken(refreshToken);
    return this.mintTokens(client.client_id, requested);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getToken(token);
    // InvalidTokenError specifically: requireBearerAuth turns it into a 401
    // with a WWW-Authenticate challenge. Any other error type becomes a 500.
    if (!record || record.kind !== 'access') throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      // AuthInfo.expiresAt is SECONDS since the epoch; the store keeps millis.
      expiresAt: Math.floor(record.expiresAt / 1000)
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // RFC 7009 §2.1: a client may only revoke its own tokens. Returning
    // silently on a mismatch is deliberate — the RFC requires 200 for an
    // invalid token, and distinguishing "not yours" from "does not exist"
    // would turn this into an oracle for guessing token values.
    const record = this.store.getToken(request.token);
    if (!record || record.clientId !== client.client_id) return;
    this.store.deleteToken(request.token);
  }

  /**
   * Exact, case-insensitive hostname match — no suffix matching, so
   * `chatgpt.com` never authorises `chatgpt.com.attacker.test`. The port is
   * ignored so a loopback callback on an ephemeral port still works.
   */
  /**
   * Fails CLOSED. An unconfigured allowlist denies every redirect target rather
   * than allowing all of them, because dynamic client registration is open:
   * without this, anyone who finds the URL can register a client named after a
   * product the operator trusts, point it at their own callback, and send an
   * /authorize link. The operator sees a real consent page on their own domain,
   * types their real password, and the code lands on the attacker's host.
   *
   * The literal `*` restores allow-any for anyone who wants it deliberately.
   */
  private redirectHostAllowed(redirectUri: string): boolean {
    if (this.allowAnyRedirectHost) return true;
    if (!this.allowedRedirectHosts) return false;
    let hostname: string;
    try {
      hostname = new URL(redirectUri).hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.allowedRedirectHosts.includes(hostname);
  }

  private verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    return constantTimeEquals(expected, codeChallenge);
  }

  private mintTokens(clientId: string, scopes: string[]): OAuthTokens {
    const access = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    this.store.saveToken({ token: access, kind: 'access', clientId, scopes, expiresAt: Date.now() + ACCESS_TTL_MS });
    this.store.saveToken({ token: refresh, kind: 'refresh', clientId, scopes, expiresAt: Date.now() + REFRESH_TTL_MS });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: scopes.join(' ')
    };
  }
}

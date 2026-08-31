import express from 'express';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from './config.js';
import { AuthStore } from './auth/store.js';
import { OscarOAuthProvider } from './auth/provider.js';
import { buildMetadataDocuments } from './auth/metadata.js';
import { createLoginRouter } from './auth/login.js';
import { buildMcpServer, buildToolContext } from './mcp.js';
import { AuditLog, rateLimit } from './audit.js';

const PURGE_INTERVAL_MS = 10 * 60 * 1000;
/** Cache rows older than the longest TTL (30 days) can never be served again. */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** `<project root>/data/oauth.db`, whether running from `src/` or `dist/`. */
const DB_PATH = fileURLToPath(new URL('../data/oauth.db', import.meta.url));

/** `<project root>/logs/audit.jsonl`, whether running from `src/` or `dist/`. */
const AUDIT_PATH = fileURLToPath(new URL('../logs/audit.jsonl', import.meta.url));

/**
 * Host-header validation for /mcp: rejects any request whose Host is not
 * allowlisted.
 *
 * Note what this does NOT do. The allowlist includes the loopback origins so
 * local smoke tests work, which means a page in the operator's browser CAN
 * reach http://127.0.0.1:3070/mcp and pass this check. That is not exploitable
 * here — /mcp carries no cookie or ambient authority, requireBearerAuth demands
 * a token such a page does not have, and the route sets no CORS headers, so a
 * response cannot be read cross-origin. The real protection is the bearer
 * token; this layer only blocks requests arriving under an unexpected name.
 *
 * StreamableHTTPServerTransport does have allowedHosts /
 * enableDnsRebindingProtection options, but they are marked @deprecated in
 * dist/esm/server/webStandardStreamableHttp.d.ts with "Use external middleware
 * for host validation instead" — so this is Express middleware rather than a
 * transport constructor option. The rejection body mirrors the SDK's own
 * (deprecated) validateRequestHeaders behaviour — 403 with a JSON-RPC error
 * envelope — for consistency with how MCP clients already parse transport
 * errors from this endpoint.
 */
export function createHostValidationMiddleware(allowedHosts: string[]): express.RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host;
    if (!host || !allowedHosts.includes(host)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Invalid Host header: ${host ?? ''}` },
        id: null
      });
      return;
    }
    next();
  };
}

/**
 * True when this module is the process's real entry point (`tsx src/server.ts`
 * / `node dist/server.js`), false when it is only imported.
 *
 * Naively this is `import.meta.url === pathToFileURL(process.argv[1]).href`.
 * That breaks under pm2's fork mode: pm2 runs `node ProcessContainerFork.js`
 * (its own wrapper script) and dynamically `import()`s the real target from
 * `process.env.pm_exec_path` — so `process.argv[1]` inside the running process
 * is pm2's wrapper path, not this file's, and the naive check is always false.
 * The symptom observed on the sibling server: pm2 showed the app "online" with
 * a live PID and growing memory (imports succeeded), but nothing was ever
 * logged and nothing bound to the port — main() was simply never called.
 * `pm_exec_path` is the path pm2 itself resolves the real target from, so it
 * takes priority over argv[1] when present.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined, pmExecPath: string | undefined): boolean {
  const entryPath = pmExecPath || argv1;
  if (!entryPath) return false;
  return metaUrl === pathToFileURL(entryPath).href;
}

function main(): void {
  const config = loadConfig();
  const audit = new AuditLog(AUDIT_PATH);
  const store = new AuthStore(DB_PATH);
  // audit is optional on ProviderOptions, but production always supplies one:
  // it records every issued authorization code (client name, id, redirect URI).
  const provider = new OscarOAuthProvider(store, {
    allowedRedirectHosts: config.allowedRedirectHosts,
    audit
  });
  // Built once per process: the /mcp handler builds a fresh McpServer per
  // request, and rebuilding the context there would reset the response cache
  // and the outbound throttle on every single call.
  const toolContext = buildToolContext(config);

  setInterval(() => {
    store.purgeExpired();
    toolContext.client.purgeCache(CACHE_MAX_AGE_MS);
  }, PURGE_INTERVAL_MS).unref();

  const issuerUrl = new URL(config.publicUrl);
  const resourceServerUrl = new URL(`${config.publicUrl}/mcp`);

  const app = express();
  // Only nginx on loopback talks to this process, so exactly one hop of
  // X-Forwarded-For is trustworthy. Without this the rate limiter sees every
  // request as 127.0.0.1 — one shared bucket for the whole internet — and logs
  // a misconfiguration error on every hit.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  // NOT mounted globally. A root-level parser reads and JSON.parses the body of
  // every request — including unauthenticated ones on paths that have no rate
  // limiter — before host validation, throttling or auth ever run, so the most
  // expensive part of handling a request that will be rejected has already
  // happened. It is mounted on /mcp below, after those gates. /login brings its
  // own urlencoded parser, and the SDK's /authorize, /token and /register each
  // mount their own.

  const allowedHosts = [issuerUrl.host, `127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const hostValidation = createHostValidationMiddleware(allowedHosts);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // NOTE: /roadmap and /roadmap.json are NOT served here. nginx serves those
  // two files statically (see Task 10) so the build-status page stays up even
  // when this process is down — which is exactly when you want to read it.
  // nginx's exact-match locations take precedence over the `location /` proxy,
  // so adding Express routes here would be unreachable dead code.

  // Login page + credential check. Mounted before the OAuth router because
  // provider.authorize() redirects here.
  app.use(createLoginRouter(store, provider, config));

  // Discovery documents, served ahead of the SDK's own copies so the corrected
  // issuer (and the bare protected-resource path) win. See auth/metadata.ts.
  const docs = buildMetadataDocuments(config.publicUrl, provider);
  const serveMetadata = (path: string, body: unknown) => {
    app.options(path, (_req, res) => {
      res.set('Access-Control-Allow-Origin', '*')
         .set('Access-Control-Allow-Methods', 'GET, OPTIONS').sendStatus(204);
    });
    app.get(path, (_req, res) => {
      res.set('Access-Control-Allow-Origin', '*')
         .set('Cache-Control', 'public, max-age=300').json(body);
    });
  };
  serveMetadata('/.well-known/oauth-authorization-server', docs.authorizationServer);
  for (const path of docs.protectedResourcePaths) serveMetadata(path, docs.protectedResource);

  // /authorize, /token, /register and /revoke. MUST be mounted at the app root.
  // Its .well-known routes are shadowed by the handlers registered above.
  app.use(mcpAuthRouter({
    provider, issuerUrl, baseUrl: issuerUrl, resourceServerUrl,
    scopesSupported: ['mcp'], resourceName: 'Oscar Health Provider Search'
  }));

  // resourceMetadataUrl is what a 401 hands the client so it can discover where
  // to authenticate; without it the WWW-Authenticate challenge is a dead end.
  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: docs.resourceMetadataUrl
  });

  // Host validation first (rebinding protection must not be bypassable by
  // omitting Authorization), then the rate limiter — which must throttle
  // unauthenticated and misauthenticated attempts too, not just successful
  // ones. That is exactly why it keys on source address rather than the
  // not-yet-verified Authorization header: this early, that header's value is
  // fully attacker-chosen. rateLimit()'s default keyFn does this (see
  // audit.ts); a second, post-auth limiter keyed on the verified token would be
  // needed for genuine per-caller fairness, and is not implemented here.
  app.all('/mcp', hostValidation, rateLimit(), auth, express.json({ limit: '1mb' }), async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await buildMcpServer(toolContext).connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(config.port, '127.0.0.1', () => {
    console.log(`oscar-mcp listening on 127.0.0.1:${config.port} (issuer ${config.publicUrl})`);
  });
}

// Only bootstrap (load config, open the databases, start listening) when this
// file is run directly (`tsx src/server.ts` / `node dist/server.js`) — not when
// it is imported, e.g. by tests that need createHostValidationMiddleware or
// isMainModule without env vars set or a live listener.
if (isMainModule(import.meta.url, process.argv[1], process.env.pm_exec_path)) {
  main();
}

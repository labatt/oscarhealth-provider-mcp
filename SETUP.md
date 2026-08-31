# Setup

## 1. Find your plan details

Everything this server needs is visible in the URL of Oscar's own provider
search. Sign in at [hioscar.com](https://www.hioscar.com), open **Find Care**,
and look at the address bar:

```
https://www.hioscar.com/search/?networkId=066&state=FL&year=2026&policyId=b5c9…&formularyPlanType=INDIVIDUAL_4_TIER
                                          ^^^        ^^     ^^^^          ^^^^                    ^^^^^^^^^^^^^^^^
                                     networkId     state    year        policyId              formularyPlanType
```

Copy those five values, plus the ZIP you want searches anchored to:

```bash
cp config/plans.example.json config/plans.json
$EDITOR config/plans.json
```

`config/plans.json` is gitignored. You can define several plans and pass
`plan: "<id>"` to any tool to switch between them.

To confirm you got it right, `describe_plan` echoes back the plan name Oscar
has on file — if that matches your insurance card, the values are correct.

## 2. Install and configure

```bash
npm install
cp .env.example .env
```

Generate the operator credential:

```bash
node -e "
const argon2 = require('argon2');
const pw = require('crypto').randomBytes(18).toString('base64url');
argon2.hash(pw, { type: argon2.argon2id }).then(h => {
  console.log('PASSWORD (save this):', pw);
  console.log('HASH (put in .env):  ', h);
});"
```

Put the hash in `MCP_LOGIN_PASSWORD_HASH`, set `MCP_SESSION_SECRET` to
`openssl rand -hex 32`, and set `MCP_PUBLIC_URL` to your public origin — no
trailing slash, since it is the OAuth issuer and must match exactly.

## 3. Run it

```bash
npm test        # 161 offline tests
npm run build
node dist/server.js
```

It listens on `127.0.0.1:3070`. Put a TLS-terminating reverse proxy in front.

### nginx

```nginx
server {
    server_name mcp.example.com;

    location / {
        proxy_pass http://127.0.0.1:3070;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streamable HTTP holds the response open. Default buffering plus a 60s
        # read timeout severs the session mid-stream, which shows up as an
        # intermittently "flaky" connector rather than an obvious timeout.
        # These four directives are load-bearing.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
    listen 443 ssl;
    # ssl_certificate ... (certbot)
}
```

The app expects exactly one hop of `X-Forwarded-For` (`trust proxy` is set to
`loopback`). If you add another proxy in front, adjust it, or every request
will look like it came from `127.0.0.1` and share one rate-limit bucket.

### Under a process manager

If you use pm2 in **fork** mode, note that `process.argv[1]` is pm2's wrapper
script rather than your app. `isMainModule` therefore consults
`process.env.pm_exec_path` first. Without that, pm2 reports the app "online"
with a live PID while nothing ever binds the port. Verify with
`ss -ltnp | grep 3070` rather than trusting the status column.

## 4. Connect a client

Add `https://your-host/mcp` as a custom MCP connector. The OAuth flow opens a
browser; sign in with the operator credentials.

Then **set `MCP_ALLOWED_REDIRECT_HOSTS`** to the callback host your client
used (`claude.ai`, for example) and restart. Dynamic client registration is
open, so until you do, anyone who finds your URL can register a client and
start an authorization request. The consent screen always shows you the
callback host, but the allowlist turns that judgement call into a refusal.

You can read the host your client registered straight from the database:

```bash
sqlite3 data/oauth.db "select * from clients;"
```

## Verifying a deployment

```
/healthz    -> 200 {"ok":true}
/mcp        -> 401 with a WWW-Authenticate header naming resource_metadata
/mcp        -> 403 if the Host header is not your public host
```

A **401** on `/mcp` is success — it means auth is wired correctly and no token
was supplied. 403 means host validation rejected the request; 502 means the app
is not listening.

# Oscar Provider MCP

An [MCP](https://modelcontextprotocol.io) server for searching an Oscar Health
in-network provider directory — doctors and facilities — from an AI assistant.

Ask *"find me a male primary care physician within 10 miles who's accepting new
patients and has good reviews"* and get an answer grounded in your own plan's
network.

> **Not affiliated with, endorsed by, or supported by Oscar Health.** This is an
> unofficial client for a public provider directory. See
> [Fair use](#fair-use) before deploying it.

## Tools

| Tool | Purpose |
| --- | --- |
| `find_specialty` | Resolve free text ("cardiologist") to a specialty ID. Call this first — IDs mix Oscar internal codes with NUCC taxonomy codes and cannot be guessed. |
| `search_doctors` | Search physicians: specialty, distance, language, group, hospital, plus local gender and review filtering. |
| `search_facilities` | Hospitals, pharmacies, labs, urgent care. |
| `get_provider_details` | Full record for one provider — every office, education, certifications. Always fetched live. |
| `describe_plan` | Your configured plan, plus the exact values the filters accept. |

## Two things it does that a thin API wrapper would not

**Gender and review quality are filtered locally.** Oscar's API accepts a
`gender` parameter and silently ignores it — every value returns the same
unfiltered count — and offers no way to sort by patient reviews. Both are
therefore applied in this server, over a bounded sample of fetched pages, and
the tool descriptions say so rather than implying a server-side filter that does
not exist.

**Reviews are ranked by Wilson score, not raw percentage.** In a 150-provider
sample, 62 of 106 rated providers scored exactly 100% — so sorting on that field
ranks one review identically to two hundred. The
[Wilson lower bound](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval)
asks what the true rate plausibly is *given the sample size*:

| Reviews | 100% recommend | Score |
| --- | --- | --- |
| 1 | ✔ | 0.21 |
| 8 | ✔ | 0.68 |
| 43 | ✔ | 0.92 |
| 209 | ✔ | 0.98 |

Providers with no reviews sort **last** under `rating` and are labelled
`unrated` rather than scored zero. No reviews is not a bad review.

## Design notes

**Responses are shaped down hard.** One upstream page of 30 providers is ~225 KB
of JSON. The compact row is 14 fields plus a nested review summary — roughly
2–3k tokens for 30 results. `get_provider_details` returns the full record when
you are vetting a shortlist.

**Providers with no gender on file are returned separately, not dropped.** About
9% of records have a blank gender field. When you filter by gender they come back
in `unknownGender` with their names, so you can judge, instead of silently
disappearing.

**Caching is aggressive and persistent** (SQLite, survives restarts): 30 days for
the specialty taxonomy, 7 for search results, and never for
`get_provider_details` — that one is the verification step before you act on a
choice, so it must not serve a cached record.

**Page fetching is capped at 5** (150 providers). Narrowing a search beats
paginating it: a 10-mile PCP search returns ~631 results against ~4,772 at 50
miles.

## Setup

```bash
git clone https://github.com/labatt/oscar-provider-mcp.git
cd oscar-provider-mcp
npm install
npm run setup
```

`npm run setup` is interactive and does the awkward parts for you. It reads
Oscar's own catalogue and has you pick your **state**, then your **network**,
then your **plan by the name printed on your insurance card** — the `policyId`,
formulary tier and a sensible default ZIP all fall out of those choices, so you
never type an opaque identifier. It then runs a real search to prove the
configuration works before writing anything:

```
State
   1. AL    3. FL    5. IA  …

Network in FL for 2026
   1. Florida EPO Off Exchange   (019, EPO)
   2. Florida HMO Broad          (070, HMO_NAME_ONLY)
   3. Florida HMO Standard       (066, HMO_NAME_ONLY)

Your plan (as printed on your insurance card)
   …
  34. Gold Classic Standard      INDIVIDUAL_4_TIER

Verifying with a real search …
  ✓ 4,123 primary care providers found near 33186.
  ✓ wrote config/plans.json  (2026 Florida HMO Standard)
```

It also generates the operator credential — prompting for a password or
inventing a strong one, hashing it with argon2id — plus a session secret, and
writes `.env` with mode `600`. **The password is printed once and stored
nowhere**; save it then.

Both `config/plans.json` and `.env` are gitignored.

<details>
<summary>Configuring by hand instead</summary>

Copy `config/plans.example.json` to `config/plans.json` and fill it in. All five
values are visible in the URL of Oscar's own search page:

```
https://www.hioscar.com/search/?networkId=066&state=FL&year=2026&policyId=b5c9…&formularyPlanType=INDIVIDUAL_4_TIER
                                          ^^^        ^^     ^^^^          ^^^^                    ^^^^^^^^^^^^^^^^
```

Then `cp .env.example .env` and generate a credential:

```bash
node -e "
const argon2 = require('argon2');
const pw = require('crypto').randomBytes(18).toString('base64url');
argon2.hash(pw, { type: argon2.argon2id }).then(h => {
  console.log('PASSWORD (save this):', pw);
  console.log('HASH (put in .env):  ', h);
});"
```

Set `MCP_SESSION_SECRET` to `openssl rand -hex 32`, and `MCP_PUBLIC_URL` to your
public origin — **no trailing slash**, since it is the OAuth issuer and must
match exactly.

You can define several plans and pass `plan: "<id>"` to any tool to switch.
</details>

## Running it

```bash
npm run build
node dist/server.js
```

It listens on `127.0.0.1:3070` and expects a TLS-terminating reverse proxy in
front. `MCP_PUBLIC_URL` must be the public HTTPS origin.

### Deploying with Claude Code

TLS certificates, reverse proxy config and a process manager are exactly the
kind of fiddly, host-specific work an agent is good at. If you have
[Claude Code](https://claude.com/claude-code) on the server, this prompt gets
you a working deployment:

```
Deploy the MCP server in this directory behind nginx with a Let's Encrypt
certificate, at https://mcp.example.com. Specifically:

1. Confirm DNS for mcp.example.com already points at this host, and stop if
   it does not — certbot's HTTP-01 challenge will fail otherwise.
2. Run `npm run build`, then start dist/server.js under a process manager
   (pm2 or systemd) bound to 127.0.0.1:3070. Verify it actually bound with
   `ss -ltnp | grep 3070` — under pm2 fork mode a process can report
   "online" while never binding, so do not trust the status column.
3. Add an nginx site proxying to 127.0.0.1:3070. Streamable HTTP holds the
   response open, so it needs: proxy_buffering off, proxy_cache off,
   proxy_read_timeout 3600s, proxy_send_timeout 3600s and
   chunked_transfer_encoding on. Without these the connector is
   intermittently flaky rather than obviously broken.
4. Obtain a certificate with certbot --nginx and reload.
5. Verify from outside: /healthz returns {"ok":true}; /mcp returns 401 with
   a WWW-Authenticate header naming resource_metadata; and confirm that
   /.env, /config/plans.json and /.git/config are NOT reachable.

Do not edit .env or anything under data/. Show me the nginx config before
reloading, and check `nginx -t` first.
```

Replace `mcp.example.com` with your host. Step 5 matters: a **401** on `/mcp` is
success — it means auth is wired and no token was supplied. A 403 means host
validation rejected the request; a 502 means the app is not listening.

<details>
<summary>Deploying by hand</summary>

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
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
    listen 443 ssl;   # certbot manages the certificate lines
}
```

The app expects exactly one hop of `X-Forwarded-For` (`trust proxy` is
`loopback`). Add another proxy in front and every request looks like it came
from `127.0.0.1`, sharing one rate-limit bucket.

Under **pm2 fork mode**, `process.argv[1]` is pm2's wrapper rather than your
app, so `isMainModule` consults `process.env.pm_exec_path` first. Without that
pm2 reports "online" with a live PID while nothing binds the port — verify with
`ss -ltnp | grep 3070`.
</details>

## Connecting a client

Add `https://your-host/mcp` as a custom MCP connector. The OAuth flow opens a
browser; sign in with your operator credentials.

Then **set `MCP_ALLOWED_REDIRECT_HOSTS`** to the callback host your client used
and restart:

```bash
sqlite3 data/oauth.db "select * from clients;"   # shows the registered callback
```

Dynamic client registration is open, so until you set this, anyone who finds
your URL can register a client and start an authorization request. The consent
screen always shows you the callback host — the allowlist turns that judgement
call into a server-side refusal.

## Example queries

Once connected, ask in plain language. Claude resolves the specialty first, then
searches — you never handle IDs.

**Finding a doctor**

> Find me a primary care physician within 10 miles who's accepting new patients.

> I want a male cardiologist with good reviews, sorted by rating.

> Are there any female dermatologists near me who speak Spanish?

> Find pediatricians affiliated with a hospital I'd actually want to be admitted to — show me which hospitals they're affiliated with.

> Who are the ten best-reviewed PCPs in my network, and how many reviews does each have?

**Narrowing a shortlist**

> Of those five, which have been practising longest and are board certified?

> Show me everything you have on the second one — all their office locations, education and certifications.

> Is Dr. Alvarez still in my network? I want to check before I book.

**Facilities**

> Find in-network pharmacies within 5 miles.

> Which hospitals are in my network, and which are accredited?

> Is there an in-network urgent care near ZIP 33139?

**Understanding your plan**

> What plan am I configured for, and what network is it?

> What languages can I filter doctors by?

> List the medical groups in my network so I can filter by one.

### What the answers will and won't tell you

Claude will say when a filter ran locally rather than upstream, because it
matters: **gender and review filters operate on a fetched sample**, not the
whole directory. A search that reports "applied locally over 90 fetched
providers" out of 4,772 has genuinely looked at 90. Narrow with a distance or a
more specific specialty and the sample covers proportionally more of what
matches.

You will also see providers with **no gender on file returned separately** rather
than dropped, with their names — about 9% of records — so you can judge for
yourself instead of losing them silently.

Things it deliberately cannot do: book appointments, quote your out-of-pocket
cost, or read anything from your member account. It only searches the public
provider directory.

## Fair use

Oscar's `robots.txt` disallows `/search/*` and `/member/*`. That directive
addresses search-engine crawling; this server makes low-volume, user-initiated
lookups against a directory that CMS transparency rules require insurers to
publish. It is built to stay on that side of the line:

- an honest User-Agent identifying the software — no browser impersonation
- a serialised outbound throttle, and in-flight de-duplication of identical requests
- a hard 5-page cap, so bulk enumeration is not reachable through any tool
- aggressive persistent caching, which is the main politeness mechanism

**Please keep those.** They are the difference between a personal lookup tool and
a scraper. Deploy it for your own plan; do not point it at a directory you have
no relationship with, and do not mirror the data.

## Development

```bash
npm test              # 161 offline tests, no network
npm run typecheck     # type-checks src/ AND test/
npm run test:contract # 17 assertions against the live API — slow, real requests
npm run build
```

Test fixtures are **synthetic**. They mirror the real response shape exactly,
including its quirks, but contain no real clinicians.

### When the contract tests fail

`npm run test:contract` pins every upstream fact this server depends on. A
failure means Oscar changed something and the *documentation* needs updating,
not the test. The ones most worth watching:

- **`gender` is still ignored server-side.** If it starts working, delete the
  local filter and send it upstream.
- **NPI is still unsearchable.** `get_provider_details` carries a `name`
  parameter purely to work around this; if Oscar adds NPI search, simplify it.
- **Facet keys still differ from labels.** `language_code=ES` matches;
  `language_code=Spanish` returns zero.

## Licence

MIT. See [LICENSE](LICENSE).

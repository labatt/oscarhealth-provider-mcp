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

See **[SETUP.md](SETUP.md)**. In short: copy your plan's `networkId`, `state`,
`year` and `policyId` out of the URL of Oscar's own search page into
`config/plans.json`, generate an operator credential, and run behind a
TLS-terminating proxy.

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

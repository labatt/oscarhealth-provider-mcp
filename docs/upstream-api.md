# The upstream API, as observed

Oscar Health's provider search has no public documentation. Everything here was
established by observing the live endpoints, and every claim was verified by
issuing the request and comparing result counts. Dates are when each was last
confirmed.

**This document exists because the API fails quietly.** An unrecognised
parameter is not rejected — it is ignored, and you get a plausible-looking
unfiltered response. A wrong field name is not an error — it is `undefined`,
and your code returns a well-formed object with the data missing. Nearly every
bug found while building this server was of that kind. What follows is mostly a
list of those traps.

The contract suite (`npm run test:contract`) asserts each of these against the
live API, so drift surfaces as a test failure rather than as quietly wrong
results.

---

## Endpoints

| Purpose | Endpoint |
| --- | --- |
| Doctor search | `GET /member/search/results/doctors/api` |
| Facility search | `GET /member/search/results/facilities/api` |
| Specialty autocomplete | `GET /search/autocomplete/multientity/` |
| Network catalogue | `GET /search/api/v2/networks` |
| Network details | `GET /search/api/v2/network-details` |
| Plans on a network | `GET /api/get-network-plans` |

**None of these require authentication.** That is not an oversight to exploit —
it reflects the directory being public. The diagnostic: every `/member/*` and
`/data-api/*` endpoint returns 401 without a session, while the search endpoints
return 200.

## Doctor search parameters

| Parameter | Behaviour |
| --- | --- |
| `network_id`, `state`, `year` | required for meaningful scoping |
| `zip_code` | anchor for distance; resolved server-side |
| `specialty` | accepts BOTH internal codes (`CLINPCPMAN`) and NUCC taxonomy codes (`207RC0000Y`) |
| `page` | **0-indexed**, 30 per page. `page=1` yields `requestInfo.pageStart = 30` |
| `distance_miles` | only `1｜5｜10｜20｜50`. Others are ignored, not rejected |
| `language_code` | ISO code, **not** the display label — see below |
| `include_no_new_patients` | `false` narrows the result set |
| `medical_group`, `hospital_affiliation` | exact string match against the facet key |
| `sort` | `0`/`1` = relevance, `2` = distance. Anything else → **HTTP 400 `VALIDATION_FAILED`** |
| `name_query` | free-text **name** match only |

## The traps

### `gender` is accepted and silently ignored

```
no filter    → 4772        gender=M     → 4772
gender=F     → 4772        gender=FEMALE→ 4772
```

Provider records *do* carry a `gender` field, so the data exists — it simply
cannot be filtered on. Any gender filtering has to happen client-side.

### NPI and provider_id are not searchable

```
no filter                → 10000     npi=<a real NPI>         → 10000
provider_id=<a real id>  → 10000     name_query=<a real NPI>  → 10000, and the
                                       target is not even on the returned page
name_query="First Last"  → 1
```

`npi=` and `provider_id=` are accepted and ignored. Only `name_query` narrows,
and only on a name. Looking a provider up by identifier therefore requires
searching by their **name** and selecting the matching record — a lookup that
sends only an NPI will search an arbitrary page, miss, and appear to prove the
provider is absent.

### Facet keys differ from their labels

The `aggregations` block returns filter values as `{key, display_str, count}`.
For languages these differ, and **the filter matches the key**:

```
language_code=ES       → 2449 of 4772
language_code=Spanish  → 0
```

Handing a UI label to the filter returns zero results — worse than an ignored
filter, because zero reads as a fact about the network rather than as an error.

### Some facet keys carry meaningful whitespace

7 of 199 hospital keys have stray leading or trailing spaces, and several exist
as **both** variants, which the API treats as distinct:

```
hospital_affiliation=" Some Hospital"  → 1
hospital_affiliation="Some Hospital"   → 141
```

Trimming the key merges two real facets into one label and makes one of them
unaddressable. Keep the key verbatim; trim only for display.

### `years_experience: 0` means "not recorded"

20 of 30 providers on a live page report `0`, including one whose board
certification was issued in 1999. Treating it as a real zero presents two thirds
of the directory as newly qualified.

### Field names that are easy to guess wrong

| Guess | Actual |
| --- | --- |
| `specialties[].name` | `specialties[].specialty_name` |
| `educations[].school_name` | `educations[].institution_name` |
| `educations[].graduation_year` | `educations[].graduation_date.{year,month,day}` |
| `educations[].education_type` | `educations[].education_program` |
| `licenses[].state` | `licenses[].license_state` |

Each returns `undefined` rather than throwing, so the shaper still produces
well-formed output — just emptier.

### Distance is per-office, not per-provider

`offices[].location.distance_miles`. A provider with several locations has
several distances; "how far away is this doctor" means the minimum.

### Validation errors arrive as an object

A rejected request returns `user_message` as an object keyed by field, not a
string:

```json
{"error": "VALIDATION_FAILED", "user_message": {"sort": ["Not a valid choice."]}}
```

Interpolating it directly yields `[object Object]` and discards the only part
that says what was wrong.

## Response shape and size

One page of 30 providers is roughly **225 KB** of JSON. Facility results are
**flat** — no `provider` wrapper — and carry a different field set entirely
(`facility_id`, `wheelchair_accessible`, `office_hours`, `accreditation_info`).

Review aggregates ride along in search results as `member_feedback`:
`{num_reviews, percent_recommend, top_provider}`. The separate `/feedback/reviews`
endpoint, which serves individual review *text*, does require authentication.

## Plan discovery

`GET /search/api/v2/networks` **with no parameters** returns the full catalogue
keyed by year, each network carrying `coverageAreas` with its state. Adding
`year` or `state` produces `400 VALIDATION_FAILED: Extra fields supplied` —
filter client-side.

`GET /api/get-network-plans?networkId=&planYear=&state=` returns plan options as
`[policyId, planName, formularyPlanType]` triples. Together these mean a user
never has to find their own `policyId`: they pick a state, a network, and a plan
name, and the identifiers follow.

## Conduct

`robots.txt` disallows `/search/*` and `/member/*`. That addresses crawling;
this server makes low-volume, user-initiated lookups against a directory CMS
transparency rules require insurers to publish. If you build on this, keep the
throttle, the caching and the page cap — see the README's Fair use section.

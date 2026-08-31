import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache } from '../../src/oscar/cache.js';
import { OscarClient, OscarUpstreamError } from '../../src/oscar/client.js';
import { endpoints, type Params } from '../../src/oscar/endpoints.js';
import { shapeDoctor, shapeAutocomplete, shapeFacets } from '../../src/oscar/shape.js';

/**
 * Contract tests against Oscar's live API.
 *
 * Every assertion here corresponds to a fact in spec §2 that this server is
 * built on. **When one of these fails, the spec is out of date — not the test.**
 * Read the failure message, verify the new upstream behaviour by hand, then
 * update the spec and whatever code depended on the old fact.
 *
 * These facts are the dangerous kind: not one of them fails loudly in
 * production. A wrong field name returns an empty array, a wrong filter value
 * returns zero results, a sentinel `0` becomes a real number in a ranking. That
 * is why this suite exists and why every expectation carries an explanation.
 *
 * Politeness: this talks to a third party serving the directory for free. The
 * client is constructed with a 1 s minimum gap between requests and `ttlMs: 0`
 * so the suite measures live behaviour rather than the cache. The whole suite
 * is roughly 18 requests. Do not add pagination loops or broad sweeps; when you
 * need more coverage, narrow the query instead.
 */

let dir: string;
let client: OscarClient;

const PLAN = { network_id: '066', state: 'FL', year: 2026, zip_code: '33101' };
const BASE = { ...PLAN, include_no_new_patients: true, sort: 1 };
/** Oscar's own code for "primary care physician", not a NUCC taxonomy code. */
const PCP = 'CLINPCPMAN';

interface RawFacetEntry { key?: string; display_str?: string; count?: number }
interface RawOfficeish { location?: { distance_miles?: number } }
interface RawProviderish {
  npi?: string;
  provider_id?: string;
  first_name?: string;
  last_name?: string;
  years_experience?: number;
  offices?: RawOfficeish[];
}
interface SearchBody {
  totalResultCount: number;
  results: { provider: RawProviderish }[];
  requestInfo?: { pageStart?: number };
  aggregations?: Record<string, RawFacetEntry[]>;
}

async function search(extra: Params = {}): Promise<SearchBody> {
  const e = endpoints.doctorSearch({ ...BASE, specialty: PCP, ...extra });
  const { body } = await client.get<SearchBody>(e.path, e.params, { ttlMs: 0 });
  return body;
}

/** Nearest-office distance for each row on a page, as the shaper computes it. */
function pageDistances(body: SearchBody): number[] {
  return body.results
    .map(r => shapeDoctor(r.provider).distanceMiles)
    .filter((d): d is number => typeof d === 'number');
}

/**
 * One unfiltered PCP page, fetched once and shared. Eight of the assertions
 * below are about this page or about a filtered page compared against it;
 * re-fetching it per test would triple the suite's request count for no gain.
 */
let baseline: SearchBody;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'contract-'));
  // A real throttle: this suite talks to a live third-party API.
  client = new OscarClient(
    'https://www.hioscar.com',
    new ResponseCache(join(dir, 'c.db')),
    { minIntervalMs: 1000 }
  );
  baseline = await search();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Oscar API contract', () => {
  it('serves doctor search without authentication', async () => {
    expect(
      baseline.totalResultCount,
      'The doctor search endpoint returned no results for an unauthenticated request. ' +
      'The entire server depends on this endpoint being open — there is no login, no ' +
      'member token and no cookie anywhere in src/oscar/client.ts. If Oscar has put ' +
      'this behind auth, every tool is dead and the project needs a new approach, not a patch.'
    ).toBeGreaterThan(0);
    expect(
      baseline.results.length,
      'totalResultCount was positive but the results array was empty. The response ' +
      'envelope changed shape; src/oscar/shape.ts and every tool read `results[].provider`.'
    ).toBeGreaterThan(0);
  });

  it('still treats page as 0-indexed with 30 results per page', async () => {
    const second = await search({ page: 1 });
    expect(
      second.requestInfo?.pageStart,
      'page=1 no longer starts at offset 30. This server treats `page` as 0-indexed ' +
      'with a fixed 30 rows per page: src/oscar/params.ts converts the caller\'s page ' +
      'and src/tools/search.ts walks pages 0..4 under the 5-page cap. If the base or ' +
      'the page size changed, pagination now silently skips or repeats providers — ' +
      'results look plausible and are wrong.'
    ).toBe(30);
    expect(
      baseline.results.length,
      'A full unfiltered page no longer returns exactly 30 rows, so the 5-page cap no ' +
      'longer means 150 providers. Re-derive the cap in src/tools/search.ts.'
    ).toBe(30);
  });

  it('STILL ignores the gender parameter server-side', async () => {
    const [male, female] = await Promise.all([search({ gender: 'M' }), search({ gender: 'F' })]);
    const note =
      'Oscar now appears to honour the `gender` parameter server-side. This is GOOD ' +
      'news and a required code change: search_doctors currently never sends gender ' +
      'upstream and instead filters locally over the pages it fetched (3 by default, ' +
      'MAX_PAGES=5, so 150 providers at most — src/tools/search.ts), which is why a ' +
      'gender-filtered search can miss matches beyond the cap and has to say so in its ' +
      'own output. If gender is a real filter now, send it upstream and delete the ' +
      'local stage. Verify by hand before changing anything — an equal count could also ' +
      'be coincidence.';
    expect(male.totalResultCount, note).toBe(baseline.totalResultCount);
    expect(female.totalResultCount, note).toBe(baseline.totalResultCount);
  });

  it('still narrows results for distance_miles', async () => {
    const [wide, narrow] = await Promise.all([
      search({ distance_miles: 50 }),
      search({ distance_miles: 1 })
    ]);
    expect(
      narrow.totalResultCount,
      `distance_miles no longer narrows the result set (1 mile: ${narrow.totalResultCount}, ` +
      `50 miles: ${wide.totalResultCount}). Only 1|5|10|20|50 are accepted upstream; ` +
      'src/tools/search.ts rejects anything else against DISTANCE_VALUES rather than ' +
      'letting Oscar ignore it. If the accepted values changed, a radius the caller ' +
      'asked for is being ignored and they get the whole state back believing it is nearby.'
    ).toBeLessThan(wide.totalResultCount);
    expect(
      narrow.totalResultCount,
      'A 1-mile radius returned nothing at all. Either the zip code default (33101) no ' +
      'longer resolves, or distance filtering broke. Distances are what search results ' +
      'are sorted and presented by.'
    ).toBeGreaterThan(0);
  });

  it('still narrows results with the ISO language code', async () => {
    const spanish = await search({ language_code: 'ES' });
    expect(
      spanish.totalResultCount,
      `language_code=ES no longer narrows the result set (${spanish.totalResultCount} of ` +
      `${baseline.totalResultCount}). describe_plan advertises these codes and ` +
      'search_doctors passes them straight through; if the parameter stopped filtering, ' +
      'a caller asking for a Spanish-speaking doctor gets the unfiltered directory back ' +
      'with no indication anything was ignored.'
    ).toBeLessThan(baseline.totalResultCount);
    expect(
      spanish.totalResultCount,
      'language_code=ES returned zero providers. Spanish is the most common non-English ' +
      'language in this network; zero means the code vocabulary changed, not that the ' +
      'doctors are gone. Check the facet keys in `aggregations["1"]`.'
    ).toBeGreaterThan(0);
  });

  it('keys language facets by ISO code, not by the display label, and only the key filters', async () => {
    const raw = baseline.aggregations?.['1'] ?? [];
    expect(
      raw.length,
      'Facet bucket "1" (language) is missing from `aggregations`. describe_plan builds ' +
      'its list of filterable languages from it (src/oscar/shape.ts shapeFacets). The ' +
      'numeric facet ids are undocumented and unlabelled upstream, so if they were ' +
      'renumbered this bucket may now be something else entirely — inspect the response ' +
      'before re-mapping FACET_LANGUAGE.'
    ).toBeGreaterThan(0);

    const differing = raw.filter(e => e.key !== e.display_str);
    expect(
      differing.length,
      'Every language facet now has key === display_str. shapeFacets deliberately keeps ' +
      'both (`code` for filtering, `value` for display) because they differ: the key is ' +
      'an ISO code like "ES" and the label is "Spanish". If they have converged, confirm ' +
      'which one the filter accepts before simplifying FacetValue — collapsing to the ' +
      'wrong one returns zero results with no error.'
    ).toBeGreaterThan(0);

    const es = shapeFacets(baseline).languages.find(l => l.code === 'ES');
    expect(
      es,
      'No language facet with the code "ES" is offered any more. shapeFacets maps ' +
      '`key` to `code`, and `code` is what describe_plan tells callers to pass as ' +
      'language_code.'
    ).toBeDefined();
    expect(
      es?.value,
      'The "ES" facet label changed. Harmless on its own, but it is what a caller sees ' +
      'when choosing a language, so the mapping from label back to code must still hold.'
    ).toBe('Spanish');

    // The label is not interchangeable with the key: passing it silently matches nothing.
    const byLabel = await search({ language_code: 'Spanish' });
    expect(
      byLabel.totalResultCount,
      `language_code=Spanish now returns ${byLabel.totalResultCount} providers instead of 0. ` +
      'Oscar has started accepting display labels as well as ISO codes. That is a ' +
      'loosening, not a break — but describe_plan\'s tool description warns callers that ' +
      'label and code differ and that they must pass the code, and that warning would ' +
      'now be stale.'
    ).toBe(0);
  });

  it('still serves member_feedback aggregates unauthenticated', async () => {
    const rows = baseline.results.map(r => shapeDoctor(r.provider));
    const rated = rows.filter(r => r.reviews !== null && r.reviews.count > 0);
    expect(
      rated.length,
      'No provider on an unfiltered page carries member_feedback with reviews. Review ' +
      'data is served without a member login today; if it moved behind auth, the ' +
      '`min_reviews` filter and the Wilson-score ranking in src/oscar/rank.ts silently ' +
      'drop every provider or rank them all equally — the search still "works" and ' +
      'returns a worse answer.'
    ).toBeGreaterThan(0);
    expect(
      rated.some(r => r.reviews!.percentRecommend !== null),
      'member_feedback is present but percent_recommend is gone from every rated ' +
      'provider. Wilson scoring needs both the count and the proportion; without the ' +
      'proportion every score is null and review ranking becomes a no-op.'
    ).toBe(true);
  });

  it('still populates gender on at least some providers', async () => {
    const rows = baseline.results.map(r => shapeDoctor(r.provider));
    const known = rows.filter(r => r.gender !== null);
    expect(
      known.length,
      'Not one provider on an unfiltered page reports a gender. Because Oscar ignores ' +
      'the gender parameter, search_doctors filters locally on this field; if it stops ' +
      'being populated, a gender-filtered search returns zero results and looks like ' +
      '"no such doctors" rather than "the data is gone".'
    ).toBeGreaterThan(0);
    expect(
      rows.every(r => r.gender === null || r.gender === 'M' || r.gender === 'F'),
      'A provider reported a gender value other than M, F or blank. shapeDoctor ' +
      'normalises anything else to null, so a new value (e.g. "X" or "U") would be ' +
      'silently discarded and those providers would vanish from any gender-filtered ' +
      'search. Widen the DoctorRow gender type before that ships.'
    ).toBe(true);
  });

  it('still treats years_experience 0 as "not recorded" rather than as zero years', async () => {
    const raw = baseline.results.map(r => r.provider.years_experience);
    const zeros = raw.filter(v => v === 0).length;
    expect(
      zeros / raw.length,
      `Only ${zeros} of ${raw.length} providers on this page report years_experience 0. ` +
      'That field is a sentinel for "not recorded", not a real zero — roughly two thirds ' +
      'of a live page reports 0, some alongside board certifications from the 1990s, so ' +
      'shapeDoctor maps 0 to null. If Oscar has started populating it properly, that ' +
      'mapping is now throwing away genuine data about newly qualified doctors and ' +
      'should be removed. This test failing is the good outcome.'
    ).toBeGreaterThan(0.3);
    expect(
      baseline.results.map(r => shapeDoctor(r.provider)).every(r => r.yearsExperience !== 0),
      'shapeDoctor let a 0 through as a number. Anything ranking or displaying ' +
      'experience would read it as "no experience".'
    ).toBe(true);
  });

  it('still exposes hospital facet keys whose whitespace is significant', async () => {
    const raw = baseline.aggregations?.['6'] ?? [];
    expect(
      raw.length,
      'Facet bucket "6" (hospital affiliation) is missing from `aggregations`. ' +
      'shapeFacets reads it for describe_plan; see the note on facet renumbering in the ' +
      'language test above.'
    ).toBeGreaterThan(0);

    const untrimmed = raw.filter(e => typeof e.key === 'string' && e.key !== e.key.trim());
    expect(
      untrimmed.length,
      'No hospital facet key carries leading or trailing whitespace any more. Oscar ' +
      'currently emits both a name with and without a leading space as separate ' +
      'facets matching different providers, and it matches the key literally — which is ' +
      'why shapeFacets keeps `code` untrimmed while trimming `value` for display. If the ' +
      'duplicates have been cleaned up upstream, that split can be simplified; if ' +
      'instead something started trimming keys in transit, a facet the caller picks will ' +
      'now match nothing.'
    ).toBeGreaterThan(0);

    const shaped = shapeFacets(baseline).hospitalAffiliations;
    expect(
      shaped.some(f => f.code !== f.value),
      'shapeFacets no longer preserves the untrimmed key: every code equals its display ' +
      'value. The raw response still contains whitespace-significant keys, so this is a ' +
      'shaper regression, not upstream drift — fix src/oscar/shape.ts.'
    ).toBe(true);
  });

  it('STILL accepts and silently ignores npi and provider_id on doctor search', async () => {
    const target = baseline.results[0].provider;
    const npi = target.npi;
    const providerId = target.provider_id;
    expect(npi, 'The first provider on an unfiltered page has no npi.').toBeTruthy();
    expect(providerId, 'The first provider on an unfiltered page has no provider_id.').toBeTruthy();

    const [byNpi, byProviderId] = await Promise.all([
      search({ npi }),
      search({ provider_id: providerId })
    ]);
    const note =
      'Oscar now appears to honour an id parameter on doctor search — it returned a ' +
      'different total than the same query with no filter. Today both parameters are ' +
      'accepted and ignored (no error, no narrowing), which is why get_provider_details ' +
      'in src/tools/lookup.ts cannot look a provider up by identifier at all: it ' +
      'searches by name_query and then picks the exact row by npi/provider_id, and it ' +
      'refuses outright when given an identifier with no name. If ids are searchable ' +
      'now, that whole workaround collapses and the name argument stops being required ' +
      '— verify by hand, then simplify it.';
    expect(byNpi.totalResultCount, note).toBe(baseline.totalResultCount);
    expect(byProviderId.totalResultCount, note).toBe(baseline.totalResultCount);
  });

  it('STILL does not match an NPI through name_query, though names do match', async () => {
    const target = baseline.results[0].provider;
    const [byNpiText, byName] = await Promise.all([
      search({ name_query: target.npi }),
      search({ name_query: `${target.first_name} ${target.last_name}` })
    ]);

    expect(
      byNpiText.results.some(r => r.provider.npi === target.npi),
      'name_query=<an NPI> now returns the provider with that NPI. name_query searches ' +
      'names only today, so passing an id there quietly returns an arbitrary unfiltered ' +
      'page — a page that does not contain the provider asked for. If NPIs are matchable ' +
      'now, get_provider_details can use this directly instead of scanning search pages.'
    ).toBe(false);

    expect(
      byName.totalResultCount,
      `name_query="${target.first_name} ${target.last_name}" returned ` +
      `${byName.totalResultCount} providers instead of narrowing to a handful. ` +
      'get_provider_details and find-by-name both rely on a full name being a strong ' +
      'filter. If it stopped narrowing, a lookup by name now returns the whole directory ' +
      'and the first row is not the person asked for.'
    ).toBeLessThan(10);
    expect(
      byName.totalResultCount,
      'A full name taken from the directory itself matched nothing. name_query no longer ' +
      'accepts "First Last" — check whether it wants a different separator or ordering.'
    ).toBeGreaterThan(0);
  });

  it('still sorts by distance for sort=2 and rejects out-of-range sort values', async () => {
    const byDistance = await search({ sort: 2 });
    const distances = pageDistances(byDistance);
    expect(
      distances.length,
      'sort=2 returned a page with no usable distances.'
    ).toBeGreaterThan(0);
    expect(
      distances.every((d, i) => i === 0 || d >= distances[i - 1]),
      'sort=2 no longer returns providers in non-decreasing distance order ' +
      `(first few: ${distances.slice(0, 5).map(d => d.toFixed(2)).join(', ')}). ` +
      'src/oscar/params.ts maps the caller\'s "distance" sort to 2 and the tool tells ' +
      'the caller results are nearest-first. If the ordering changed, that claim is now ' +
      'a lie in user-facing prose while the results still look reasonable.'
    ).toBe(true);
    expect(
      distances[0],
      'The nearest provider under sort=2 is no closer than the nearest under smart sort, ' +
      'which suggests sort=2 is being ignored and silently falling back to the default.'
    ).toBeLessThanOrEqual(pageDistances(baseline)[0]);

    // Out-of-range values must be rejected, not silently treated as the default.
    let rejected: unknown = null;
    try {
      await search({ sort: 3 });
    } catch (err) {
      rejected = err;
    }
    expect(
      rejected,
      'sort=3 no longer errors. Only 0/1 (smart) and 2 (distance) are valid today, and ' +
      'src/oscar/params.ts only ever sends one of them (UPSTREAM_SORT). A ' +
      'silently-accepted out-of-range value is the worst case: the caller asks for an ' +
      'ordering, gets the default, and nothing anywhere says so. Find out what sort=3 ' +
      'means now before allowing it through.'
    ).toBeInstanceOf(OscarUpstreamError);
    expect(
      (rejected as OscarUpstreamError).status,
      'sort=3 was rejected with an unexpected status. A 4xx means Oscar validated the ' +
      'parameter; a 5xx would mean something else is wrong and this test proves nothing.'
    ).toBe(400);
  });

  it('still resolves "cardiol" to the Cardiologist taxonomy code', async () => {
    const e = endpoints.autocomplete({ query: 'cardiol', ...PLAN });
    const { body } = await client.get(e.path, e.params, { ttlMs: 0 });
    const matches = shapeAutocomplete(body);
    expect(
      matches.length,
      'Autocomplete returned no specialty matches for "cardiol". find_specialty is the ' +
      'documented first call for every search, and shapeAutocomplete keeps only ' +
      'group_type 4 (doctor specialties) and 8 (facility specialties). Empty here means ' +
      'either the group_type numbering or the response_fields nesting changed — both ' +
      'fail silently, returning a well-formed empty list.'
    ).toBeGreaterThan(0);
    expect(
      matches.find(m => m.name === 'Cardiologist')?.id,
      'Autocomplete no longer maps "Cardiologist" to the NUCC taxonomy code 207RC0000Y. ' +
      'The ids find_specialty hands back are fed straight into search_doctors as ' +
      '`specialty`; if the id vocabulary changed, every downstream search for a ' +
      'specialty resolved this way returns nothing.'
    ).toBe('207RC0000Y');
    expect(
      matches.some(m => m.kind === 'facility'),
      'No facility specialty came back for "cardiol". find_specialty reports both kinds ' +
      'so the caller knows whether to search doctors or facilities; group_type 8 may ' +
      'have been renumbered.'
    ).toBe(true);
  });

  it('still accepts a NUCC taxonomy code as the specialty parameter', async () => {
    const e = endpoints.doctorSearch({ ...BASE, specialty: '207RC0000Y' });
    const { body } = await client.get<SearchBody>(e.path, e.params, { ttlMs: 0 });
    expect(
      body.totalResultCount,
      'A NUCC taxonomy code (207RC0000Y, Cardiologist) is no longer accepted as ' +
      '`specialty` on doctor search. The two id vocabularies must stay interchangeable ' +
      'here: find_specialty returns NUCC codes from autocomplete while the plan defaults ' +
      'use Oscar\'s own codes like CLINPCPMAN. If only one is accepted now, find_specialty ' +
      'hands back ids that search_doctors cannot use — and a rejected specialty comes ' +
      'back as an empty result set, not an error.'
    ).toBeGreaterThan(0);
  });

  it('still reports network 066 as the Florida HMO Standard plan', async () => {
    const e = endpoints.networkDetails({ year: 2026, networkId: '066' });
    const { body } = await client.get<{ name?: string }>(e.path, e.params, { ttlMs: 0 });
    expect(
      body.name,
      `Network 066 for plan year 2026 is now named ${JSON.stringify(body.name)}. Every ` +
      'default in config/plans.json — network, policy id, state, zip — describes one ' +
      'specific Florida HMO plan. If 066 has been reassigned, every search is silently ' +
      'querying somebody else\'s network and the in-network answers are wrong for the ' +
      'operator. Do not adjust this test; re-verify the plan.'
    ).toContain('Florida');
  });

  it('still serves facility search with specialty_id', async () => {
    const e = endpoints.facilitySearch({ ...BASE, specialty_id: '282N00000X' });
    const { body } = await client.get<{ totalResultCount: number; results: unknown[] }>(
      e.path, e.params, { ttlMs: 0 }
    );
    expect(
      body.totalResultCount,
      'Facility search returned nothing for specialty_id=282N00000X (General Acute Care ' +
      'Hospital). Note the parameter name: facilities use `specialty_id` while doctors ' +
      'use `specialty`. Sending the wrong one is accepted and ignored, so this comes ' +
      'back as an unfiltered or empty list rather than an error.'
    ).toBeGreaterThan(0);
    expect(
      body.results.length,
      'Facility search reported a positive total but returned no rows; the response ' +
      'envelope changed. shapeFacility reads `results[]` directly — facilities are flat ' +
      'records, not wrapped in a `provider` key like doctors are.'
    ).toBeGreaterThan(0);
  });
});

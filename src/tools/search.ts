import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { endpoints } from '../oscar/endpoints.js';
import { TTL } from '../oscar/client.js';
import { shapeDoctor, type DoctorRow } from '../oscar/shape.js';
import { applyLocalFilters, sortRows, type SortMode } from '../oscar/rank.js';
import { resolvePlan } from '../plans.js';
import { planParams, MAX_PAGES, PAGE_SIZE, UPSTREAM_SORT, DISTANCE_VALUES, type DistanceMiles } from '../oscar/params.js';
import { shapeFacility, type FacilityRow } from '../oscar/shape.js';

export interface SearchDoctorsArgs {
  specialty?: string;
  nameQuery?: string;
  zipCode?: string;
  distanceMiles?: DistanceMiles;
  languageCode?: string;
  medicalGroup?: string;
  hospitalAffiliation?: string;
  includeNoNewPatients?: boolean;
  gender?: 'M' | 'F';
  minReviews?: number;
  topRatedOnly?: boolean;
  sort?: SortMode;
  limit?: number;
  maxPages?: number;
  plan?: string;
  refresh?: boolean;
}

export interface SearchDoctorsResult {
  plan: string;
  totalMatchingUpstream: number;
  fetched: number;
  returned: number;
  results: DoctorRow[];
  unknownGender: DoctorRow[];
  excluded: { byReviews: number; byTopRated: number; byNewPatients: number };
  truncated: boolean;
  cachedAt: string | null;
  notes: string[];
}

interface RawSearchResponse {
  totalResultCount?: number;
  results?: { provider: unknown }[];
}

export async function searchDoctors(ctx: ToolContext, args: SearchDoctorsArgs): Promise<SearchDoctorsResult> {
  const plan = resolvePlan(ctx.plans, args.plan);

  if (args.distanceMiles !== undefined && !DISTANCE_VALUES.includes(args.distanceMiles)) {
    throw new Error(
      `distanceMiles must be one of ${DISTANCE_VALUES.join(', ')} — Oscar ignores any other value.`
    );
  }

  const limit = args.limit ?? 20;
  // Local sorts and filters need a pool larger than `limit` to choose from, but
  // the cap is absolute: the directory must not be bulk-enumerable.
  const requestedPages = args.maxPages ?? (args.gender || args.minReviews || args.topRatedOnly || args.sort === 'rating' || args.sort === 'most_reviewed' ? 3 : 1);
  const maxPages = Math.min(requestedPages, MAX_PAGES);

  const base = {
    ...planParams(plan),
    ...(args.zipCode ? { zip_code: args.zipCode } : {}),
    specialty: args.specialty,
    name_query: args.nameQuery,
    distance_miles: args.distanceMiles,
    language_code: args.languageCode,
    medical_group: args.medicalGroup,
    hospital_affiliation: args.hospitalAffiliation,
    include_no_new_patients: args.includeNoNewPatients ?? true,
    // Gender is deliberately absent: verified 2026-08-30 that Oscar accepts and
    // ignores it, returning unfiltered counts. Sending it would imply a
    // server-side filter that does not exist.
    sort: args.sort === 'distance' ? UPSTREAM_SORT.distance : UPSTREAM_SORT.smart
  };

  const collected: DoctorRow[] = [];
  let total = 0;
  let oldestCachedAt: number | null = null;
  let pagesFetched = 0;

  // Sequential by design. The client's throttle serialises callers anyway, and
  // fetching one page at a time is what keeps the upstream request rate low.
  for (let page = 0; page < maxPages; page++) {
    const e = endpoints.doctorSearch({ ...base, page });
    const { body, cachedAt } = await ctx.client.get<RawSearchResponse>(
      e.path, e.params, { ttlMs: TTL.SEARCH, refresh: args.refresh }
    );
    pagesFetched++;
    total = body.totalResultCount ?? 0;
    if (cachedAt !== null) oldestCachedAt = oldestCachedAt === null ? cachedAt : Math.min(oldestCachedAt, cachedAt);

    const rows = (body.results ?? []).map(r => shapeDoctor(r.provider));
    collected.push(...rows);

    if (rows.length < PAGE_SIZE) break;
    if (collected.length >= total) break;
  }

  const filtered = applyLocalFilters(collected, {
    gender: args.gender,
    minReviews: args.minReviews,
    topRatedOnly: args.topRatedOnly
  });

  // Ranking runs over everything fetched; `limit` is applied only afterwards, so
  // slicing never discards a provider that would have ranked above the cut.
  const sorted = sortRows(filtered.results, args.sort ?? 'smart').slice(0, limit);
  const unknown = sortRows(filtered.unknownGender, args.sort ?? 'smart').slice(0, limit);

  const notes: string[] = [];
  if (args.gender) {
    // Counted before the slice: `unknown` is capped at `limit`, so its length
    // would understate how many unknown-gender providers the sample held and
    // the model would relay that shortfall as a fact about the directory.
    const unknownFound = filtered.unknownGender.length;
    notes.push(
      `Oscar's API cannot filter by gender, so this was applied locally over ${collected.length} fetched providers. ` +
      `${unknownFound} provider(s) have no gender recorded and are listed separately under unknownGender ` +
      `(${unknown.length} shown) — their names are included so you can judge.`
    );
  }
  if (args.sort === 'rating') {
    notes.push(
      'Ranked by Wilson lower-bound score, which discounts small samples: 1 perfect review scores ~0.21, ' +
      '43 perfect reviews ~0.92. Unrated providers sort last.'
    );
  }
  const truncated = collected.length < total;
  if (truncated) {
    notes.push(
      `Fetched ${collected.length} of ${total} matching providers (${pagesFetched} page(s), hard cap ${MAX_PAGES}). ` +
      'Narrow with distanceMiles or a more specific specialty rather than paging further.'
    );
  }

  return {
    plan: plan.label,
    totalMatchingUpstream: total,
    fetched: collected.length,
    returned: sorted.length,
    results: sorted,
    unknownGender: unknown,
    excluded: filtered.excluded,
    truncated,
    cachedAt: oldestCachedAt ? new Date(oldestCachedAt).toISOString() : null,
    notes
  };
}

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_doctors',
    {
      title: 'Search in-network doctors',
      description:
        'Search Oscar Health in-network physicians. Call find_specialty first to get a specialty ID. ' +
        'NOTE: gender, minReviews, topRatedOnly and the rating/most_reviewed sorts are NOT supported by ' +
        "Oscar's API — this server applies them locally over up to 5 fetched pages (150 providers), so " +
        'they operate on a sample, not the whole directory. Narrow with distanceMiles for better coverage. ' +
        'Providers with no gender on file are returned separately in unknownGender rather than dropped.',
      inputSchema: {
        specialty: z.string().max(120).optional().describe('Specialty ID from find_specialty, e.g. "CLINPCPMAN" or "207RC0000Y".'),
        nameQuery: z.string().max(120).optional().describe('Search by provider name instead of specialty.'),
        zipCode: z.string().max(120).optional().describe('Override the plan default ZIP (33101).'),
        distanceMiles: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(20), z.literal(50)])
          .optional().describe('Radius. Only 1, 5, 10, 20 and 50 are accepted upstream. Default 50.'),
        languageCode: z.string().max(120).optional()
          .describe('ISO language code, e.g. "ES" for Spanish. Pass the "code" field from describe_plan\'s language facets, not the readable label — "Spanish" matches nothing.'),
        medicalGroup: z.string().max(120).optional()
          .describe('Medical group. Pass the "code" field from describe_plan\'s medicalGroups facets verbatim, not the readable label.'),
        hospitalAffiliation: z.string().max(120).optional()
          .describe('Hospital. Pass the "code" field from describe_plan\'s hospitalAffiliations facets verbatim, not the readable label; some codes carry meaningful leading spaces.'),
        includeNoNewPatients: z.boolean().optional().describe('Include doctors not accepting new patients. Default true.'),
        gender: z.enum(['M', 'F']).optional().describe('LOCAL filter — Oscar ignores this server-side.'),
        minReviews: z.number().int().min(0).optional().describe('LOCAL filter: minimum review count.'),
        topRatedOnly: z.boolean().optional().describe("LOCAL filter: Oscar's top_provider flag only."),
        sort: z.enum(['smart', 'distance', 'rating', 'most_reviewed']).optional()
          .describe('smart and distance run upstream; rating and most_reviewed are local.'),
        limit: z.number().int().min(1).max(50).optional().describe('Rows to return after ranking. Default 20.'),
        maxPages: z.number().int().min(1).max(5).optional().describe('Upstream pages to fetch, 30 each. Hard cap 5.'),
        plan: z.string().optional(),
        refresh: z.boolean().optional().describe('Bypass the 7-day cache.')
      }
    },
    async args => {
      const out = await searchDoctors(ctx, args as SearchDoctorsArgs);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
    }
  );
}

export interface SearchFacilitiesArgs {
  specialtyId?: string;
  nameQuery?: string;
  zipCode?: string;
  distanceMiles?: DistanceMiles;
  sort?: 'smart' | 'distance';
  limit?: number;
  plan?: string;
  refresh?: boolean;
}

export interface SearchFacilitiesResult {
  plan: string;
  totalMatchingUpstream: number;
  returned: number;
  results: FacilityRow[];
  truncated: boolean;
  cachedAt: string | null;
}

interface RawFacilityResponse {
  totalResultCount?: number;
  /** Facility results are flat — no `provider` wrapper, unlike doctor search. */
  results?: unknown[];
}

export async function searchFacilities(ctx: ToolContext, args: SearchFacilitiesArgs): Promise<SearchFacilitiesResult> {
  const plan = resolvePlan(ctx.plans, args.plan);

  if (args.distanceMiles !== undefined && !DISTANCE_VALUES.includes(args.distanceMiles)) {
    throw new Error(`distanceMiles must be one of ${DISTANCE_VALUES.join(', ')} — Oscar ignores any other value.`);
  }

  const e = endpoints.facilitySearch({
    ...planParams(plan),
    ...(args.zipCode ? { zip_code: args.zipCode } : {}),
    specialty_id: args.specialtyId,
    name_query: args.nameQuery,
    distance_miles: args.distanceMiles,
    sort: args.sort === 'distance' ? UPSTREAM_SORT.distance : UPSTREAM_SORT.smart,
    page: 0
  });

  const { body, cachedAt } = await ctx.client.get<RawFacilityResponse>(
    e.path, e.params, { ttlMs: TTL.SEARCH, refresh: args.refresh }
  );

  const rows = (body.results ?? []).map(shapeFacility);
  const ordered = args.sort === 'distance'
    ? [...rows].sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity))
    : rows;
  const limited = ordered.slice(0, args.limit ?? 20);
  const total = body.totalResultCount ?? rows.length;

  return {
    plan: plan.label,
    totalMatchingUpstream: total,
    returned: limited.length,
    results: limited,
    truncated: rows.length < total,
    cachedAt: cachedAt ? new Date(cachedAt).toISOString() : null
  };
}

export function registerFacilityTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_facilities',
    {
      title: 'Search in-network facilities',
      description:
        'Search Oscar in-network hospitals, pharmacies, labs and urgent care. Call find_specialty with ' +
        'kind="facility" first to get a specialty ID (e.g. 282N00000X = General Hospital, ' +
        '3336C0003X = Pharmacy). Facilities carry no gender or review data, so those filters do not apply.',
      inputSchema: {
        specialtyId: z.string().max(120).optional().describe('Facility specialty ID from find_specialty.'),
        nameQuery: z.string().max(120).optional().describe('Search by facility name.'),
        zipCode: z.string().max(120).optional(),
        distanceMiles: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(20), z.literal(50)]).optional(),
        sort: z.enum(['smart', 'distance']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        plan: z.string().optional(),
        refresh: z.boolean().optional()
      }
    },
    async args => {
      const out = await searchFacilities(ctx, args as SearchFacilitiesArgs);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
    }
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { endpoints } from '../oscar/endpoints.js';
import { TTL } from '../oscar/client.js';
import { shapeAutocomplete, type SpecialtyMatch } from '../oscar/shape.js';
import { resolvePlan } from '../plans.js';
import { planParams } from '../oscar/params.js';
import { shapeDoctorDetail, type DoctorDetail } from '../oscar/shape.js';

export interface FindSpecialtyArgs {
  query: string;
  kind?: 'doctor' | 'facility';
  plan?: string;
}

export async function findSpecialty(ctx: ToolContext, args: FindSpecialtyArgs): Promise<SpecialtyMatch[]> {
  const plan = resolvePlan(ctx.plans, args.plan);
  const { network_id, state, year } = planParams(plan);
  const e = endpoints.autocomplete({ query: args.query, network_id, state, year });
  const { body } = await ctx.client.get(e.path, e.params, { ttlMs: TTL.SPECIALTY });
  const matches = shapeAutocomplete(body);
  return args.kind ? matches.filter(m => m.kind === args.kind) : matches;
}

export function registerLookupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_specialty',
    {
      title: 'Find a specialty ID',
      description:
        'Resolve free text (e.g. "cardiologist", "dermatology", "hospital") into the specialty IDs ' +
        'that search_doctors and search_facilities require. Call this FIRST for any search that names ' +
        'a specialty — the IDs are a mix of Oscar internal codes (CLINPCPMAN) and NUCC taxonomy codes ' +
        '(207RC0000Y) and cannot be guessed. Returns doctor specialties and facility specialties; ' +
        'use kind to narrow.',
      inputSchema: {
        query: z.string().min(2).describe('Free-text specialty or facility type, e.g. "cardiologist".'),
        kind: z.enum(['doctor', 'facility']).optional()
          .describe('Restrict to doctor specialties or facility types.'),
        plan: z.string().optional().describe('Plan id from config/plans.json. Defaults to the configured plan.')
      }
    },
    async args => {
      const matches = await findSpecialty(ctx, args as FindSpecialtyArgs);
      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No specialties matched "${args.query}".` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(matches, null, 2) }] };
    }
  );
}

export interface ProviderDetailArgs {
  providerId?: string;
  npi?: string;
  /** The provider's name, as returned by search. The only key upstream can query on — see below. */
  name?: string;
  plan?: string;
}

interface RawSearchResponse {
  results?: { provider: { npi?: string; provider_id?: string } }[];
}

/**
 * There is no single-provider endpoint on the public search API, so this
 * re-queries search and picks the exact match by NPI or provider_id. Always
 * live (ttlMs 0): this is the operator's verification step immediately before
 * acting on a choice, so a week-old cached record would defeat its purpose.
 *
 * `name` is what actually narrows the query. Verified 2026-08-30 against the
 * live API: `name_query` is a name-text filter only — `name_query=<a real
 * name>` returns 1 result, `name_query=<nonsense>` returns 0, but
 * `name_query=1700373578` (a real, in-network NPI) returns the unfiltered
 * 10000-result ceiling and does not surface that provider. `npi=`,
 * `npis=` and `provider_id=` are accepted and silently ignored — each returns
 * byte-for-byte the no-filter page — and autocomplete matches no NPI either.
 * So an identifier alone cannot be looked up; pass the name from the search
 * result alongside it and the identifier selects the exact row.
 */
export async function getProviderDetails(ctx: ToolContext, args: ProviderDetailArgs): Promise<DoctorDetail> {
  if (!args.providerId && !args.npi) {
    throw new Error('Provide either providerId or npi.');
  }
  const plan = resolvePlan(ctx.plans, args.plan);
  const e = endpoints.doctorSearch({
    ...planParams(plan),
    name_query: args.name ?? args.npi,
    include_no_new_patients: true,
    sort: 1,
    page: 0
  });

  const { body } = await ctx.client.get<RawSearchResponse>(e.path, e.params, { ttlMs: 0 });
  const match = (body.results ?? []).find(r =>
    (args.npi && r.provider.npi === args.npi) ||
    (args.providerId && r.provider.provider_id === args.providerId)
  );

  if (!match) {
    // Without a name the query was never narrowed, so "not found" here says
    // nothing about the network — do not let it read as a coverage fact.
    throw new Error(
      args.name
        ? `No provider found for ${args.npi ?? args.providerId} among the matches for "${args.name}" ` +
          `in the ${plan.label} network. They may have left the network, or the identifier may be wrong.`
        : `Cannot look up ${args.npi ?? args.providerId} by identifier alone: Oscar's API cannot search ` +
          'by NPI or provider_id. Pass the provider\'s name from the search result as `name` as well; ' +
          'the identifier is then used to pick the exact match.'
    );
  }
  return shapeDoctorDetail(match.provider);
}

export function registerDetailTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_provider_details',
    {
      title: 'Get full provider details',
      description:
        'Fetch the complete record for one provider: every office location, education, board ' +
        'certifications, licenses and full review aggregates. Always fetched live, bypassing the ' +
        'cache — use this to verify a provider is still in-network before acting on a choice. ' +
        'Pass BOTH name and npi (or providerId) from the search result: Oscar can only search by name, ' +
        'so the name finds the candidates and the identifier picks the exact one.',
      inputSchema: {
        name: z.string().optional()
          .describe('The provider\'s name exactly as returned by search. Required in practice — Oscar cannot search by NPI or provider_id.'),
        npi: z.string().optional().describe('10-digit NPI from a search result, used to pick the exact match.'),
        providerId: z.string().optional().describe('Oscar provider_id from a search result, used to pick the exact match.'),
        plan: z.string().optional()
      }
    },
    async args => {
      const out = await getProviderDetails(ctx, args as ProviderDetailArgs);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
    }
  );
}

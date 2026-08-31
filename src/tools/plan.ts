import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { endpoints } from '../oscar/endpoints.js';
import { TTL } from '../oscar/client.js';
import { resolvePlan } from '../plans.js';
import { shapeFacets } from '../oscar/shape.js';
import { planParams } from '../oscar/params.js';

export function registerPlanTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'describe_plan',
    {
      title: 'Describe the configured insurance plan',
      description:
        'Report which Oscar plan, network, state, year and home ZIP this server searches by default, ' +
        'plus the plan name Oscar has on file. Also returns the exact values accepted by ' +
        "search_doctors' languageCode, medicalGroup and hospitalAffiliation filters — those need exact " +
        'strings, so call this before using them. Each facet entry has a readable "value" and the ' +
        '"code" to pass to the filter; pass the code, they differ (language "Spanish" has code "ES"). ' +
        'Set includeFilterValues=false to skip that second lookup when you only need the plan identity.',
      inputSchema: {
        plan: z.string().optional().describe('Plan id from config/plans.json. Defaults to the configured plan.'),
        includeFilterValues: z.boolean().optional()
          .describe('Fetch the live facet lists for the filter parameters. Default true.')
      }
    },
    async args => {
      const plan = resolvePlan(ctx.plans, args.plan as string | undefined);
      const e = endpoints.networkDetails({ year: plan.year, networkId: plan.networkId });
      const { body, cachedAt } = await ctx.client.get<Record<string, unknown>>(
        e.path, e.params, { ttlMs: TTL.NETWORK }
      );

      // Facets are only ever returned alongside search results, so discovering
      // the valid filter values costs one broad search. Cached for 7 days.
      let filterValues: unknown = undefined;
      if (args.includeFilterValues !== false) {
        const se = endpoints.doctorSearch({
          ...planParams(plan),
          specialty: 'CLINPCPMAN',
          include_no_new_patients: true,
          sort: 1,
          page: 0
        });
        const { body: searchBody } = await ctx.client.get(se.path, se.params, { ttlMs: TTL.SEARCH });
        filterValues = shapeFacets(searchBody);
      }

      const out = {
        configured: plan,
        upstream: {
          name: body.name,
          lineOfBusiness: body.lineOfBusiness,
          networkType: body.networkType,
          coverageAreas: body.coverageAreas
        },
        availablePlans: Object.keys(ctx.plans.plans),
        filterValues,
        cachedAt: cachedAt ? new Date(cachedAt).toISOString() : null
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
    }
  );
}

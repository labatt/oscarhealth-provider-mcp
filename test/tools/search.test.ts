import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { searchDoctors, registerSearchTools } from '../../src/tools/search.js';

const fixture = JSON.parse(readFileSync('test/fixtures/doctors-page0.json', 'utf8'));

/** Builds a page of `n` synthetic providers so pagination logic can be exercised. */
function page(n: number, total: number, over: Record<string, unknown> = {}) {
  const template = fixture.results[0].provider;
  return {
    totalResultCount: total,
    results: Array.from({ length: n }, (_, i) => ({
      provider: { ...template, npi: String(1000000000 + i), first_name: `Doc${i}`, ...over }
    }))
  };
}

function ctx(pages: unknown[]) {
  let call = 0;
  const get = vi.fn(async () => ({ body: pages[Math.min(call++, pages.length - 1)], cachedAt: null }));
  return {
    client: { get },
    plans: {
      defaultPlan: 'fl-2026',
      plans: { 'fl-2026': {
        label: 'x', year: 2026, state: 'FL', networkId: '066',
        policyId: 'pid', zipCode: '33101', formularyPlanType: 'INDIVIDUAL_4_TIER'
      } }
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('searchDoctors', () => {
  it('fetches a single page when the first page satisfies the limit', async () => {
    const c = ctx([page(30, 30)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', limit: 10 });
    expect(c.client.get).toHaveBeenCalledTimes(1);
  });

  it('reports the upstream total separately from what it returned', async () => {
    const out = await searchDoctors(ctx([page(30, 4772)]), { specialty: 'CLINPCPMAN', limit: 5 });
    expect(out.totalMatchingUpstream).toBe(4772);
    expect(out.returned).toBe(5);
  });

  it('never exceeds the hard 5-page cap even when asked for more', async () => {
    const c = ctx([page(30, 10_000)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', maxPages: 99, limit: 1000 });
    expect(c.client.get.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('stops paginating once the upstream total is exhausted', async () => {
    const c = ctx([page(10, 10)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', maxPages: 5, limit: 100 });
    expect(c.client.get).toHaveBeenCalledTimes(1);
  });

  it('sends 0-indexed page numbers upstream', async () => {
    const c = ctx([page(30, 200)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', maxPages: 2, limit: 60 });
    expect(c.client.get.mock.calls[0][1].page).toBe(0);
    expect(c.client.get.mock.calls[1][1].page).toBe(1);
  });

  it('never sends the gender parameter upstream, because Oscar ignores it', async () => {
    const c = ctx([page(30, 30)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', gender: 'M' });
    for (const call of c.client.get.mock.calls) {
      expect(call[1]).not.toHaveProperty('gender');
    }
  });

  it('maps the sort mode to the upstream code, using smart for local sorts', async () => {
    const c = ctx([page(30, 30)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', sort: 'rating' });
    expect(c.client.get.mock.calls[0][1].sort).toBe(1);
  });

  it('maps distance sort to upstream code 2', async () => {
    const c = ctx([page(30, 30)]);
    await searchDoctors(c, { specialty: 'CLINPCPMAN', sort: 'distance' });
    expect(c.client.get.mock.calls[0][1].sort).toBe(2);
  });

  it('returns unknown-gender providers separately when filtering by gender', async () => {
    const c = ctx([{
      totalResultCount: 2,
      results: [
        { provider: { ...fixture.results[0].provider, gender: 'M', first_name: 'Male', last_name: 'One' } },
        { provider: { ...fixture.results[0].provider, gender: '', first_name: 'Unknown', last_name: 'Two' } }
      ]
    }]);
    const out = await searchDoctors(c, { specialty: 'CLINPCPMAN', gender: 'M' });
    expect(out.results).toHaveLength(1);
    expect(out.unknownGender).toHaveLength(1);
    expect(out.notes.join(' ')).toMatch(/gender/i);
  });

  it('counts every unknown-gender provider in the note, not just the ones it listed', async () => {
    const provider = (over: Record<string, unknown>) => ({ provider: { ...fixture.results[0].provider, ...over } });
    const c = ctx([{
      totalResultCount: 3,
      results: [
        provider({ gender: 'M', first_name: 'Male', last_name: 'One' }),
        provider({ gender: '', first_name: 'Unknown', last_name: 'Two' }),
        provider({ gender: '', first_name: 'Unknown', last_name: 'Three' })
      ]
    }]);
    const out = await searchDoctors(c, { specialty: 'CLINPCPMAN', gender: 'M', limit: 1 });
    // The list is capped at `limit`; the note describes the whole sample, so it
    // must not report the capped length as the number of providers found.
    expect(out.unknownGender).toHaveLength(1);
    expect(out.notes.join(' ')).toMatch(/2 provider\(s\) have no gender recorded/);
  });

  it('rejects a distance not on the upstream ladder', async () => {
    await expect(
      searchDoctors(ctx([page(1, 1)]), { specialty: 'CLINPCPMAN', distanceMiles: 7 as 5 })
    ).rejects.toThrow(/1, 5, 10, 20, 50/);
  });

  it('flags truncation when more upstream results exist than were fetched', async () => {
    const out = await searchDoctors(ctx([page(30, 4772)]), { specialty: 'CLINPCPMAN', maxPages: 1 });
    expect(out.truncated).toBe(true);
  });

  it('honours the limit after ranking, not before', async () => {
    const c = ctx([{
      totalResultCount: 3,
      results: [
        { provider: { ...fixture.results[0].provider, first_name: 'Few', member_feedback: { num_reviews: 1, percent_recommend: 1, top_provider: false } } },
        { provider: { ...fixture.results[0].provider, first_name: 'Many', member_feedback: { num_reviews: 99, percent_recommend: 1, top_provider: true } } }
      ]
    }]);
    const out = await searchDoctors(c, { specialty: 'CLINPCPMAN', sort: 'rating', limit: 1 });
    expect(out.results[0].name).toMatch(/Many/);
  });
});

describe('registerSearchTools', () => {
  it('documents the facet filters as taking the code, not the label', () => {
    const registered: Record<string, { inputSchema: Record<string, { description?: string }> }> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = { registerTool: (name: string, cfg: any) => { registered[name] = cfg; } } as any;
    registerSearchTools(server, ctx([]));

    const schema = registered['search_doctors'].inputSchema;
    for (const field of ['languageCode', 'medicalGroup', 'hospitalAffiliation']) {
      // "Spanish" returns 0 providers where the code "ES" returns 2449, so the
      // description has to say which of describe_plan's two fields to pass.
      expect(schema[field].description).toMatch(/code/i);
      expect(schema[field].description).toMatch(/describe_plan/);
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { searchFacilities } from '../../src/tools/search.js';

const fixture = JSON.parse(readFileSync('test/fixtures/facilities-hospitals.json', 'utf8'));

function ctx(body: unknown) {
  return {
    client: { get: vi.fn(async () => ({ body, cachedAt: null })) },
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

describe('searchFacilities', () => {
  it('shapes flat facility records', async () => {
    const out = await searchFacilities(ctx(fixture), { specialtyId: '282N00000X' });
    expect(out.results[0].name).toMatch(/\S/);
  });

  it('sends specialty_id, not specialty', async () => {
    const c = ctx(fixture);
    await searchFacilities(c, { specialtyId: '282N00000X' });
    expect(c.client.get.mock.calls[0][1]).toHaveProperty('specialty_id', '282N00000X');
    expect(c.client.get.mock.calls[0][1]).not.toHaveProperty('specialty');
  });

  it('reports the upstream total', async () => {
    const out = await searchFacilities(ctx({ ...fixture, totalResultCount: 76 }), { specialtyId: '282N00000X' });
    expect(out.totalMatchingUpstream).toBe(76);
  });

  it('sorts by distance when asked', async () => {
    const c = ctx({
      totalResultCount: 2,
      results: [
        { ...fixture.results[0], name: 'Far', location: { distance_miles: 20, address: {} } },
        { ...fixture.results[0], name: 'Near', location: { distance_miles: 2, address: {} } }
      ]
    });
    const out = await searchFacilities(c, { specialtyId: 'x', sort: 'distance' });
    expect(out.results.map(r => r.name)).toEqual(['Near', 'Far']);
  });
});

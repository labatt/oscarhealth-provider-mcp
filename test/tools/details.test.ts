import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getProviderDetails } from '../../src/tools/lookup.js';

const fixture = JSON.parse(readFileSync('test/fixtures/doctors-page0.json', 'utf8'));
const target = fixture.results[0].provider;

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

describe('getProviderDetails', () => {
  it('returns the full record including every office', async () => {
    const out = await getProviderDetails(ctx(fixture), { npi: target.npi });
    expect(out.offices).toHaveLength(target.offices.length);
  });

  it('always bypasses the cache, because this is the verification step', async () => {
    const c = ctx(fixture);
    await getProviderDetails(c, { npi: target.npi });
    const opts = c.client.get.mock.calls[0][2];
    expect(opts.ttlMs).toBe(0);
  });

  it('throws a clear error when the provider is not found', async () => {
    await expect(
      getProviderDetails(ctx({ totalResultCount: 0, results: [] }), { npi: '9999999999' })
    ).rejects.toThrow(/9999999999/);
  });

  it('requires either providerId or npi', async () => {
    await expect(getProviderDetails(ctx(fixture), {})).rejects.toThrow(/providerId or npi/);
  });
});

// Added during implementation. The plan sent the NPI as `name_query`, but
// `name_query` is a name-text filter: verified against the live API on
// 2026-08-30, `name_query=1700373578` (a real in-network NPI) returns the
// unfiltered 10000-result ceiling without that provider on page 0, and `npi=`,
// `npis=` and `provider_id=` are accepted and ignored. So the name is what
// narrows the query and the identifier only picks the row.
describe('getProviderDetails identifier lookup', () => {
  it('queries upstream by name when one is given, not by the NPI', async () => {
    const c = ctx(fixture);
    await getProviderDetails(c, { npi: target.npi, name: 'Alex Alvarez' });
    const params = c.client.get.mock.calls[0][1];
    expect(params.name_query).toBe('Alex Alvarez');
  });

  it('explains that an identifier alone is not searchable, rather than blaming the network', async () => {
    await expect(
      getProviderDetails(ctx({ totalResultCount: 10000, results: [] }), { npi: '9999999999' })
    ).rejects.toThrow(/cannot search by NPI or provider_id/i);
  });

  it('still matches on provider_id when that is the identifier given', async () => {
    const out = await getProviderDetails(ctx(fixture), {
      providerId: target.provider_id, name: 'Alex Alvarez'
    });
    expect(out.npi).toBe(target.npi);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { findSpecialty } from '../../src/tools/lookup.js';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync('test/fixtures/autocomplete-cardiol.json', 'utf8'));

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

describe('findSpecialty', () => {
  it('returns doctor specialties with their ids', async () => {
    const out = await findSpecialty(ctx(fixture), { query: 'cardiol' });
    expect(out.find(m => m.name === 'Cardiologist')?.id).toBe('207RC0000Y');
  });

  it('filters to the requested kind', async () => {
    const out = await findSpecialty(ctx(fixture), { query: 'cardiol', kind: 'facility' });
    expect(out.every(m => m.kind === 'facility')).toBe(true);
  });

  it('uses the long specialty TTL, since the taxonomy is effectively static', async () => {
    const c = ctx(fixture);
    await findSpecialty(c, { query: 'cardiol' });
    expect(c.client.get.mock.calls[0][2].ttlMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('returns an empty array rather than throwing on no matches', async () => {
    const out = await findSpecialty(ctx({ results: [] }), { query: 'zzzz' });
    expect(out).toEqual([]);
  });
});

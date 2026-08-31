import { describe, it, expect } from 'vitest';
import { planParams, DISTANCE_VALUES } from '../../src/oscar/params.js';

const plan = {
  label: 'x', year: 2026, state: 'FL', networkId: '066',
  policyId: 'pid', zipCode: '33101', formularyPlanType: 'INDIVIDUAL_4_TIER'
};

describe('planParams', () => {
  it('maps camelCase plan fields to the upstream snake_case names', () => {
    expect(planParams(plan)).toEqual({
      network_id: '066', state: 'FL', year: 2026, zip_code: '33101'
    });
  });
});

describe('DISTANCE_VALUES', () => {
  it('matches exactly the radii the upstream accepts', () => {
    expect([...DISTANCE_VALUES]).toEqual([1, 5, 10, 20, 50]);
  });
});

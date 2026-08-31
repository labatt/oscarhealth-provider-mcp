import { describe, it, expect } from 'vitest';
import { resolvePlan, type PlanBook } from '../src/plans.js';

const book: PlanBook = {
  defaultPlan: 'fl-2026',
  plans: {
    'fl-2026': {
      label: '2026 Florida HMO Standard',
      year: 2026, state: 'FL', networkId: '066',
      policyId: '00000000-0000-0000-0000-000000000000',
      zipCode: '33101', formularyPlanType: 'INDIVIDUAL_4_TIER'
    }
  }
};

describe('resolvePlan', () => {
  it('returns the default plan when no id is given', () => {
    expect(resolvePlan(book).networkId).toBe('066');
  });

  it('returns a named plan', () => {
    expect(resolvePlan(book, 'fl-2026').year).toBe(2026);
  });

  it('throws a listing error for an unknown plan id', () => {
    expect(() => resolvePlan(book, 'nope')).toThrow(/Unknown plan "nope".*fl-2026/);
  });

  it('does not resolve inherited object properties as plans', () => {
    // `plans['constructor']` and friends are truthy through the prototype
    // chain, so a `!plan` guard let `plan: "constructor"` through and produced
    // an all-undefined parameter set — an unscoped upstream request.
    for (const key of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(() => resolvePlan(book, key)).toThrow(/Unknown plan/);
    }
  });
});

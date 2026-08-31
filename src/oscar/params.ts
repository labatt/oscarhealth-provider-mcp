import type { Plan } from '../plans.js';

/** The only radii the upstream accepts; anything else is silently ignored by Oscar. */
export const DISTANCE_VALUES = [1, 5, 10, 20, 50] as const;
export type DistanceMiles = (typeof DISTANCE_VALUES)[number];

/** Upstream sort codes. Verified: 0/1 = smart, 2 = distance; 3+ are rejected with HTTP 400 VALIDATION_FAILED. */
export const UPSTREAM_SORT = { smart: 1, distance: 2 } as const;

/** Hard cap. Not configurable at runtime — see spec §8. */
export const MAX_PAGES = 5;
export const PAGE_SIZE = 30;

export function planParams(plan: Plan): { network_id: string; state: string; year: number; zip_code: string } {
  return {
    network_id: plan.networkId,
    state: plan.state,
    year: plan.year,
    zip_code: plan.zipCode
  };
}

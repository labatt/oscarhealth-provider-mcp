/**
 * Wilson score lower bound at 95% confidence. See Task 4 and spec §3.1 for why
 * raw percent_recommend is not usable as a ranking key.
 */
export function wilsonLowerBound(positive: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = positive / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (centre - margin) / denominator;
}

import type { DoctorRow } from './shape.js';

export type SortMode = 'smart' | 'distance' | 'rating' | 'most_reviewed';

export interface LocalFilters {
  gender?: 'M' | 'F';
  minReviews?: number;
  topRatedOnly?: boolean;
  acceptingNewPatientsOnly?: boolean;
}

export interface PartitionedResults {
  results: DoctorRow[];
  /**
   * Providers matching every filter EXCEPT that Oscar records no gender for
   * them. Returned separately rather than dropped: roughly 9% of providers
   * have a blank gender field, and silently discarding them would hide good
   * matches with no signal that anything was missing. The operator can usually
   * infer gender from the name.
   */
  unknownGender: DoctorRow[];
  excluded: { byReviews: number; byTopRated: number; byNewPatients: number };
}

/**
 * Applies every filter the upstream API cannot. Gender is partitioned rather
 * than filtered; all other criteria apply equally to both buckets, so a
 * provider excluded by minReviews never reappears via the unknown-gender list.
 */
export function applyLocalFilters(rows: DoctorRow[], filters: LocalFilters): PartitionedResults {
  const excluded = { byReviews: 0, byTopRated: 0, byNewPatients: 0 };

  const passesNonGender = (r: DoctorRow): boolean => {
    if (filters.acceptingNewPatientsOnly && r.acceptingNewPatients === false) {
      excluded.byNewPatients++;
      return false;
    }
    if (filters.topRatedOnly && r.reviews?.topProvider !== true) {
      excluded.byTopRated++;
      return false;
    }
    if (filters.minReviews !== undefined && (r.reviews?.count ?? 0) < filters.minReviews) {
      excluded.byReviews++;
      return false;
    }
    return true;
  };

  // Gender is narrowed FIRST, before the counting filters run, so the `excluded`
  // tallies describe only providers the caller actually asked about. Counting
  // across everyone made a search for women report male providers as "excluded
  // by review count" — a number the model would relay to the user as if it
  // described their search. Providers with no gender on file stay in, so the
  // remaining filters still apply to them and they cannot reappear in
  // `unknownGender` after failing one.
  const relevant = filters.gender
    ? rows.filter(r => r.gender === filters.gender || r.gender === null)
    : rows;

  const eligible = relevant.filter(passesNonGender);

  if (!filters.gender) {
    return { results: eligible, unknownGender: [], excluded };
  }

  return {
    results: eligible.filter(r => r.gender === filters.gender),
    unknownGender: eligible.filter(r => r.gender === null),
    excluded
  };
}

/** Rating sorts put unrated providers last: no reviews is not the same as bad reviews. */
export function sortRows(rows: DoctorRow[], mode: SortMode): DoctorRow[] {
  const copy = [...rows];
  switch (mode) {
    case 'rating':
      return copy.sort((a, b) => (b.reviews?.score ?? -1) - (a.reviews?.score ?? -1));
    case 'most_reviewed':
      return copy.sort((a, b) => (b.reviews?.count ?? -1) - (a.reviews?.count ?? -1));
    case 'distance':
      return copy.sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
    case 'smart':
    default:
      // Upstream already ordered these; re-sorting would discard Oscar's ranking.
      return copy;
  }
}

import { describe, it, expect } from 'vitest';
import { wilsonLowerBound, applyLocalFilters, sortRows } from '../../src/oscar/rank.js';
import type { DoctorRow } from '../../src/oscar/shape.js';

function row(over: Partial<DoctorRow> = {}): DoctorRow {
  return {
    name: 'Test Doctor', npi: '1234567890', providerId: 'p1', gender: 'M',
    specialties: ['Cardiologist'], practice: null, address: null, distanceMiles: 5,
    phone: null, acceptingNewPatients: true, languages: [], yearsExperience: 10,
    boardCertified: true, costTier: 2, reviews: null, ...over
  };
}

function reviews(count: number, pct: number, top = false) {
  return { count, percentRecommend: pct, topProvider: top, score: wilsonLowerBound(pct * count, count) };
}

describe('wilsonLowerBound', () => {
  // These four values are quoted in the spec (§3.1) and in the tool description.
  it('scores a single perfect review near 0.21', () => {
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.21, 2);
  });

  it('scores 8 perfect reviews near 0.68', () => {
    expect(wilsonLowerBound(8, 8)).toBeCloseTo(0.68, 2);
  });

  it('scores 43 perfect reviews near 0.92', () => {
    expect(wilsonLowerBound(43, 43)).toBeCloseTo(0.92, 2);
  });

  it('scores 209 perfect reviews near 0.98', () => {
    expect(wilsonLowerBound(209, 209)).toBeCloseTo(0.98, 2);
  });

  it('ranks many perfect reviews above few perfect reviews', () => {
    expect(wilsonLowerBound(43, 43)).toBeGreaterThan(wilsonLowerBound(1, 1));
  });

  it('ranks 90% of 100 above 100% of 2', () => {
    expect(wilsonLowerBound(90, 100)).toBeGreaterThan(wilsonLowerBound(2, 2));
  });

  it('returns 0 for no reviews rather than dividing by zero', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('returns 0 for zero positives', () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });
});

describe('applyLocalFilters', () => {
  it('separates unknown gender instead of discarding it', () => {
    const rows = [row({ gender: 'M' }), row({ gender: 'F' }), row({ gender: null, name: 'Jordan Lee' })];
    const out = applyLocalFilters(rows, { gender: 'M' });
    expect(out.results).toHaveLength(1);
    expect(out.unknownGender.map(r => r.name)).toEqual(['Jordan Lee']);
  });

  it('leaves unknownGender empty when no gender filter is requested', () => {
    const rows = [row({ gender: null }), row({ gender: 'F' })];
    const out = applyLocalFilters(rows, {});
    expect(out.results).toHaveLength(2);
    expect(out.unknownGender).toHaveLength(0);
  });

  it('drops providers below minReviews and counts the exclusions', () => {
    const rows = [row({ reviews: reviews(2, 1) }), row({ reviews: reviews(30, 1) })];
    const out = applyLocalFilters(rows, { minReviews: 10 });
    expect(out.results).toHaveLength(1);
    expect(out.excluded.byReviews).toBe(1);
  });

  it('treats an unrated provider as below any minReviews floor', () => {
    const out = applyLocalFilters([row({ reviews: null })], { minReviews: 1 });
    expect(out.results).toHaveLength(0);
  });

  it('keeps unrated providers when no review floor is set', () => {
    const out = applyLocalFilters([row({ reviews: null })], {});
    expect(out.results).toHaveLength(1);
  });

  it('filters to top-rated providers only', () => {
    const rows = [row({ reviews: reviews(10, 1, true) }), row({ reviews: reviews(10, 1, false) })];
    expect(applyLocalFilters(rows, { topRatedOnly: true }).results).toHaveLength(1);
  });

  it('applies the gender filter to the unknown bucket too, not just results', () => {
    // An unknown-gender provider that fails minReviews must not resurface in unknownGender.
    const rows = [row({ gender: null, reviews: reviews(1, 1) })];
    const out = applyLocalFilters(rows, { gender: 'F', minReviews: 10 });
    expect(out.unknownGender).toHaveLength(0);
  });
});

describe('sortRows', () => {
  it('sorts by Wilson score descending for rating', () => {
    const few = row({ name: 'Few', reviews: reviews(1, 1) });
    const many = row({ name: 'Many', reviews: reviews(43, 1) });
    expect(sortRows([few, many], 'rating').map(r => r.name)).toEqual(['Many', 'Few']);
  });

  it('places unrated providers last under rating, not first', () => {
    const unrated = row({ name: 'Unrated', reviews: null });
    const rated = row({ name: 'Rated', reviews: reviews(3, 0.5) });
    expect(sortRows([unrated, rated], 'rating').map(r => r.name)).toEqual(['Rated', 'Unrated']);
  });

  it('sorts by review count for most_reviewed', () => {
    const a = row({ name: 'A', reviews: reviews(5, 1) });
    const b = row({ name: 'B', reviews: reviews(50, 0.8) });
    expect(sortRows([a, b], 'most_reviewed').map(r => r.name)).toEqual(['B', 'A']);
  });

  it('sorts by distance ascending, nulls last', () => {
    const near = row({ name: 'Near', distanceMiles: 1 });
    const far = row({ name: 'Far', distanceMiles: 20 });
    const unknown = row({ name: 'Unknown', distanceMiles: null });
    expect(sortRows([far, unknown, near], 'distance').map(r => r.name)).toEqual(['Near', 'Far', 'Unknown']);
  });

  it('preserves upstream order for smart', () => {
    const a = row({ name: 'A', reviews: reviews(1, 1) });
    const b = row({ name: 'B', reviews: reviews(99, 1) });
    expect(sortRows([a, b], 'smart').map(r => r.name)).toEqual(['A', 'B']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ name: 'A', distanceMiles: 9 }), row({ name: 'B', distanceMiles: 1 })];
    sortRows(rows, 'distance');
    expect(rows.map(r => r.name)).toEqual(['A', 'B']);
  });

  it('counts exclusions only among providers matching the requested gender', () => {
    // Counting across everyone reported providers of the unwanted gender as
    // "excluded by review count", which the model would relay to the user as
    // though it described their search.
    const rows = [row({ gender: 'M', reviews: reviews(1, 1) }), row({ gender: 'F', reviews: reviews(50, 1) })];
    const out = applyLocalFilters(rows, { gender: 'F', minReviews: 10 });
    expect(out.results).toHaveLength(1);
    expect(out.excluded.byReviews).toBe(0);
  });

  it('still counts an unknown-gender provider excluded by another filter', () => {
    // Unknown-gender providers remain subject to every other filter, so their
    // exclusions are real and must be counted.
    const rows = [row({ gender: null, reviews: reviews(1, 1) }), row({ gender: 'F', reviews: reviews(50, 1) })];
    const out = applyLocalFilters(rows, { gender: 'F', minReviews: 10 });
    expect(out.unknownGender).toHaveLength(0);
    expect(out.excluded.byReviews).toBe(1);
  });

  it('keeps providers whose accepting-new-patients status is unknown', () => {
    // Asymmetric with minReviews by design: an unrated provider is treated as
    // zero reviews, but unknown acceptance is not treated as refusal. Pinned
    // here because nothing else in the suite fixes this behaviour.
    const rows = [
      row({ acceptingNewPatients: null }),
      row({ acceptingNewPatients: false }),
      row({ acceptingNewPatients: true })
    ];
    const out = applyLocalFilters(rows, { acceptingNewPatientsOnly: true });
    expect(out.results).toHaveLength(2);
    expect(out.excluded.byNewPatients).toBe(1);
  });
});

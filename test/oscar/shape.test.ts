import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shapeDoctor, shapeFacility, shapeAutocomplete, shapeDoctorDetail } from '../../src/oscar/shape.js';

const doctors = JSON.parse(readFileSync('test/fixtures/doctors-page0.json', 'utf8'));
const facilities = JSON.parse(readFileSync('test/fixtures/facilities-hospitals.json', 'utf8'));
const autocomplete = JSON.parse(readFileSync('test/fixtures/autocomplete-cardiol.json', 'utf8'));

describe('shapeDoctor', () => {
  const rows = doctors.results.map((r: { provider: unknown }) => shapeDoctor(r.provider));

  it('joins the provider name from its parts', () => {
    expect(rows[0].name).toMatch(/\S/);
    expect(rows[0].name).not.toContain('  ');
  });

  it('extracts the NPI as a string', () => {
    expect(rows[0].npi).toMatch(/^\d{10}$/);
  });

  it('reads specialties from specialty_name, not name', () => {
    // The upstream field is `specialty_name`; a shaper reading `.name` yields nulls.
    expect(rows[0].specialties.every((s: unknown) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('normalises blank gender to null rather than empty string', () => {
    for (const row of rows) expect(row.gender === null || row.gender === 'M' || row.gender === 'F').toBe(true);
  });

  it('takes distance from the nearest office', () => {
    const raw = doctors.results[0].provider;
    const distances = raw.offices.map((o: { location: { distance_miles: number } }) => o.location.distance_miles);
    expect(rows[0].distanceMiles).toBeCloseTo(Math.min(...distances), 5);
  });

  it('maps languages to display names', () => {
    expect(Array.isArray(rows[0].languages)).toBe(true);
  });

  it('returns null reviews when member_feedback is absent, never a zero score', () => {
    const noFeedback = shapeDoctor({ ...doctors.results[0].provider, member_feedback: null });
    expect(noFeedback.reviews).toBeNull();
  });

  it('summarises reviews when member_feedback is present', () => {
    const withFeedback = shapeDoctor({
      ...doctors.results[0].provider,
      member_feedback: { num_reviews: 43, percent_recommend: 1.0, top_provider: true }
    });
    expect(withFeedback.reviews).toMatchObject({ count: 43, percentRecommend: 1.0, topProvider: true });
    expect(withFeedback.reviews!.score).toBeCloseTo(0.918, 2);
  });

  it('omits every heavyweight field from the compact row', () => {
    // The compact row exists to keep 30 results near 2-3k tokens.
    for (const key of ['educations', 'offices', 'certifications', 'structured_attributes', 'tin_infos']) {
      expect(rows[0]).not.toHaveProperty(key);
    }
  });

  it('sets boardCertified from a non-empty certifications list', () => {
    const certified = shapeDoctor({
      ...doctors.results[0].provider,
      certifications: [{ board_description: 'American Board of Family Medicine', issue_year: 2015 }]
    });
    expect(certified.boardCertified).toBe(true);
  });
});

describe('shapeDoctorDetail', () => {
  it('includes every office, not just the nearest', () => {
    const raw = doctors.results[0].provider;
    expect(shapeDoctorDetail(raw).offices).toHaveLength(raw.offices.length);
  });

  it('includes education and certifications', () => {
    const d = shapeDoctorDetail(doctors.results[0].provider);
    expect(Array.isArray(d.education)).toBe(true);
    expect(Array.isArray(d.certifications)).toBe(true);
  });
});

describe('shapeFacility', () => {
  it('shapes the flat facility record without a provider wrapper', () => {
    const row = shapeFacility(facilities.results[0]);
    expect(row.name).toMatch(/\S/);
    expect(row.facilityId).toMatch(/\S/);
  });

  it('exposes wheelchair accessibility', () => {
    expect(typeof shapeFacility(facilities.results[0]).wheelchairAccessible).toBe('boolean');
  });
});

describe('shapeAutocomplete', () => {
  const matches = shapeAutocomplete(autocomplete);

  it('returns doctor specialties from group_type 4', () => {
    expect(matches.some(m => m.kind === 'doctor')).toBe(true);
  });

  it('finds Cardiologist with its NUCC taxonomy id', () => {
    expect(matches.find(m => m.name === 'Cardiologist')?.id).toBe('207RC0000Y');
  });

  it('excludes name and drug matches, keeping only specialties', () => {
    // Groups 2 (doctor names), 5 (drugs) and 6 (facility names) are not specialties.
    expect(matches.every(m => m.kind === 'doctor' || m.kind === 'facility')).toBe(true);
    expect(matches.length).toBeLessThan(autocomplete.results.length);
  });

  it('treats years_experience 0 as unknown rather than as zero years', () => {
    // Upstream sentinel: 20 of 30 live providers report 0, one alongside a
    // 1999 board certification. Zero would misrepresent them as brand new.
    const unknown = shapeDoctor({ ...doctors.results[0].provider, years_experience: 0 });
    expect(unknown.yearsExperience).toBeNull();
    const known = shapeDoctor({ ...doctors.results[0].provider, years_experience: 8 });
    expect(known.yearsExperience).toBe(8);
  });

  it('picks the nearest office when a provider has several', () => {
    // Every provider in the recorded fixtures has exactly one office, so the
    // Math.min path is otherwise untested against anything but a single value.
    const multi = shapeDoctor({
      ...doctors.results[0].provider,
      offices: [
        { office_name: 'Far', phone: '1', accepting_new_patients: true,
          location: { distance_miles: 22.5, address: { address_line_1: '3 Far St', city: 'Miami', state: 'FL', zipcode: '33101' } } },
        { office_name: 'Near', phone: '2', accepting_new_patients: false,
          location: { distance_miles: 1.4, address: { address_line_1: '1 Near St', city: 'Miami', state: 'FL', zipcode: '33102' } } },
        { office_name: 'Mid', phone: '3', accepting_new_patients: true,
          location: { distance_miles: 9.9, address: { address_line_1: '2 Mid St', city: 'Miami', state: 'FL', zipcode: '33103' } } }
      ]
    });
    expect(multi.distanceMiles).toBe(1.4);
    expect(multi.practice).toBe('Near');
    expect(multi.phone).toBe('2');
    // The nearest office's own acceptance status must travel with it.
    expect(multi.acceptingNewPatients).toBe(false);
  });
});

import { shapeFacets } from '../../src/oscar/shape.js';

describe('shapeFacets', () => {
  const facets = shapeFacets(doctors);

  it('reads languages from facet key 1', () => {
    expect(facets.languages.some(f => f.value === 'Spanish')).toBe(true);
  });

  it('reads medical groups from facet key 14', () => {
    expect(facets.medicalGroups.length).toBeGreaterThan(0);
  });

  it('reads hospital affiliations from facet key 6', () => {
    expect(facets.hospitalAffiliations.length).toBeGreaterThan(0);
  });

  it('carries the count alongside each value', () => {
    expect(facets.languages[0]).toHaveProperty('count');
    expect(typeof facets.languages[0].count).toBe('number');
  });

  it('returns empty arrays when aggregations are absent, rather than throwing', () => {
    expect(shapeFacets({}).languages).toEqual([]);
  });
});

describe('shapeFacets exact filter strings', () => {
  const facets = shapeFacets(doctors);

  it('carries the language code the language_code filter accepts, not just the display name', () => {
    // Verified live 2026-08-30 against the PCP search used by describe_plan:
    // language_code=ES returns 2449 of 4772 providers, language_code=Spanish
    // returns 0. describe_plan exists to hand out exactly-matching filter
    // values, so the code has to travel with the label.
    expect(facets.languages.find(f => f.value === 'Spanish')?.code).toBe('ES');
  });

  it('preserves upstream keys verbatim, including the stray leading spaces', () => {
    // Upstream matches hospital_affiliation exactly, and some keys carry stray
    // leading or trailing spaces that make them DISTINCT facets from their
    // trimmed twin — measured live, one such pair held 1 provider against 141.
    // Trimming the code would collapse those into duplicate labels carrying
    // each other's counts, leaving one of them unaddressable.
    const codes = facets.hospitalAffiliations.map(f => f.code);
    const untrimmed = codes.filter(c => c !== c.trim());
    expect(untrimmed.length).toBeGreaterThan(0);
    // For at least one, the trimmed twin also exists as its own separate facet.
    expect(untrimmed.some(c => codes.includes(c.trim()))).toBe(true);
  });

  it('gives every facet entry a non-empty code', () => {
    const all = [...facets.languages, ...facets.medicalGroups, ...facets.hospitalAffiliations];
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.code.length).toBeGreaterThan(0);
  });
});

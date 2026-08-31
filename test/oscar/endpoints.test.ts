import { describe, it, expect } from 'vitest';
import { endpoints } from '../../src/oscar/endpoints.js';

describe('endpoints', () => {
  it('builds the doctor search path', () => {
    expect(endpoints.doctorSearch({ specialty: 'CLINPCPMAN' }).path)
      .toBe('/member/search/results/doctors/api');
  });

  it('builds the facility search path', () => {
    expect(endpoints.facilitySearch({ specialty_id: '282N00000X' }).path)
      .toBe('/member/search/results/facilities/api');
  });

  it('builds autocomplete with the fixed category list', () => {
    const e = endpoints.autocomplete({ query: 'cardio' });
    expect(e.path).toBe('/search/autocomplete/multientity/');
    expect(e.params.categories).toBe('2,4,5,6,8');
  });

  it('builds network details', () => {
    expect(endpoints.networkDetails({ year: 2026, networkId: '066' }).path)
      .toBe('/search/api/v2/network-details');
  });
});

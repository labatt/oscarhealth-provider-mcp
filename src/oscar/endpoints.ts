export type Params = Record<string, string | number | boolean | undefined>;
export interface Endpoint { path: string; params: Params; }

/**
 * Autocomplete category codes, from the web bundle's group-type enum:
 * 2=doctor names, 4=doctor specialties, 5=drugs, 6=facility names,
 * 8=facility specialties. Sent as a fixed set; callers filter by group_type
 * in the response rather than by varying this.
 */
const AUTOCOMPLETE_CATEGORIES = '2,4,5,6,8';

export const endpoints = {
  doctorSearch: (params: Params): Endpoint =>
    ({ path: '/member/search/results/doctors/api', params }),

  facilitySearch: (params: Params): Endpoint =>
    ({ path: '/member/search/results/facilities/api', params }),

  autocomplete: (params: Params): Endpoint =>
    ({ path: '/search/autocomplete/multientity/', params: { ...params, categories: AUTOCOMPLETE_CATEGORIES } }),

  networkDetails: (params: Params): Endpoint =>
    ({ path: '/search/api/v2/network-details', params })
};

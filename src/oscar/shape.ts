import { wilsonLowerBound } from './rank.js';
import type {
  RawProvider, RawFacility, RawOffice, RawAutocompleteResult, RawMemberFeedback
} from './types.js';

export interface ReviewSummary {
  count: number;
  percentRecommend: number | null;
  topProvider: boolean;
  /** Wilson lower bound — see rank.ts. Null when percentRecommend is unknown. */
  score: number | null;
}

export interface DoctorRow {
  name: string;
  npi: string | null;
  providerId: string | null;
  gender: 'M' | 'F' | null;
  specialties: string[];
  practice: string | null;
  address: string | null;
  distanceMiles: number | null;
  phone: string | null;
  acceptingNewPatients: boolean | null;
  languages: string[];
  yearsExperience: number | null;
  boardCertified: boolean;
  costTier: number | null;
  reviews: ReviewSummary | null;
}

export interface OfficeRow {
  name: string | null;
  address: string | null;
  phone: string | null;
  distanceMiles: number | null;
  acceptingNewPatients: boolean | null;
}

export interface DoctorDetail extends DoctorRow {
  offices: OfficeRow[];
  education: string[];
  certifications: string[];
  licenses: string[];
}

export interface FacilityRow {
  name: string;
  facilityId: string | null;
  specialties: string[];
  address: string | null;
  distanceMiles: number | null;
  phone: string | null;
  acceptingNewPatients: boolean | null;
  wheelchairAccessible: boolean;
  website: string | null;
  accredited: boolean;
}

export interface SpecialtyMatch {
  id: string;
  name: string;
  kind: 'doctor' | 'facility';
}

/** Collapses the double spaces that appear when middle_name is blank. */
function fullName(p: RawProvider): string {
  return [p.first_name, p.middle_name, p.last_name]
    .filter(part => part && part.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAddress(o: RawOffice | RawFacility): string | null {
  const a = o.location?.address;
  if (!a) return null;
  const street = [a.address_line_1, a.address_line_2].filter(s => s && s.trim()).join(' ');
  const tail = [a.city, a.state].filter(Boolean).join(', ');
  const line = [street, tail, a.zipcode].filter(s => s && String(s).trim()).join(', ');
  return line.length > 0 ? line : null;
}

/** Offices are ordered arbitrarily upstream; the nearest one is what a searcher means by "where". */
function nearestOffice(p: RawProvider): RawOffice | null {
  const offices = p.offices ?? [];
  if (offices.length === 0) return null;
  return offices.reduce((best, o) => {
    const d = o.location?.distance_miles ?? Infinity;
    const bd = best.location?.distance_miles ?? Infinity;
    return d < bd ? o : best;
  });
}

function summariseReviews(fb: RawMemberFeedback | null | undefined): ReviewSummary | null {
  if (!fb || typeof fb.num_reviews !== 'number' || fb.num_reviews <= 0) return null;
  const pct = typeof fb.percent_recommend === 'number' ? fb.percent_recommend : null;
  return {
    count: fb.num_reviews,
    percentRecommend: pct,
    topProvider: fb.top_provider === true,
    score: pct === null ? null : wilsonLowerBound(pct * fb.num_reviews, fb.num_reviews)
  };
}

/** Blank strings become null so "unknown gender" is one value, not two. */
function normaliseGender(g: string | undefined): 'M' | 'F' | null {
  const v = (g ?? '').trim().toUpperCase();
  return v === 'M' || v === 'F' ? v : null;
}

/**
 * Upstream uses 0 for "not recorded", not for "newly qualified": 20 of the 30
 * providers on a live page report 0, one of them alongside a board
 * certification issued in 1999. Passing it through as a real zero would rank
 * two thirds of the directory as having no experience, so it becomes null.
 * A genuinely new provider reads as unknown, which is the safer error.
 */
function normaliseYearsExperience(v: number | undefined): number | null {
  return typeof v === 'number' && v > 0 ? v : null;
}

function specialtyNames(p: RawProvider | RawFacility): string[] {
  return (p.specialties ?? [])
    .map(s => s.specialty_name ?? s.internal_specialty_display)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

export function shapeDoctor(raw: unknown): DoctorRow {
  const p = raw as RawProvider;
  const office = nearestOffice(p);
  return {
    name: fullName(p),
    npi: p.npi ?? null,
    providerId: p.provider_id ?? null,
    gender: normaliseGender(p.gender),
    specialties: specialtyNames(p),
    practice: office?.office_name?.trim() || null,
    address: office ? formatAddress(office) : null,
    distanceMiles: office?.location?.distance_miles ?? null,
    phone: office?.phone?.trim() || null,
    acceptingNewPatients: office?.accepting_new_patients ?? null,
    languages: (p.languages ?? [])
      .map(l => l.display_name_english)
      .filter((l): l is string => typeof l === 'string' && l.length > 0),
    yearsExperience: normaliseYearsExperience(p.years_experience),
    boardCertified: (p.certifications ?? []).some(c => (c.board_description ?? '').trim().length > 0),
    costTier: typeof p.cost_to_member_bucket === 'number' ? p.cost_to_member_bucket : null,
    reviews: summariseReviews(p.member_feedback)
  };
}

export function shapeDoctorDetail(raw: unknown): DoctorDetail {
  const p = raw as RawProvider;
  return {
    ...shapeDoctor(raw),
    offices: (p.offices ?? []).map(o => ({
      name: o.office_name?.trim() || null,
      address: formatAddress(o),
      phone: o.phone?.trim() || null,
      distanceMiles: o.location?.distance_miles ?? null,
      acceptingNewPatients: o.accepting_new_patients ?? null
    })),
    // Field names differ from the plan's draft: see the note in types.ts. The
    // school is `institution_name` and the year is `graduation_date.year`;
    // both are routinely blank upstream, hence filter(Boolean).
    education: (p.educations ?? [])
      .map(e => [e.degree, e.institution_name, e.graduation_date?.year || null].filter(Boolean).join(' — '))
      .filter(s => s.length > 0),
    certifications: (p.certifications ?? [])
      .map(c => c.board_description?.trim() ?? '')
      .filter(s => s.length > 0),
    licenses: (p.licenses ?? [])
      .map(l => [l.license_state, l.license_number].filter(Boolean).join(' '))
      .filter(s => s.trim().length > 0)
  };
}

export function shapeFacility(raw: unknown): FacilityRow {
  const f = raw as RawFacility;
  return {
    name: (f.name ?? '').trim(),
    facilityId: f.facility_id ?? null,
    specialties: specialtyNames(f),
    address: formatAddress(f),
    distanceMiles: f.location?.distance_miles ?? null,
    phone: f.phone?.trim() || null,
    acceptingNewPatients: f.accepting_new_patients ?? null,
    wheelchairAccessible: f.wheelchair_accessible === true,
    website: f.website?.trim() || null,
    accredited: f.has_accreditation === true
  };
}

const GROUP_DOCTOR_SPECIALTY = 4;
const GROUP_FACILITY_SPECIALTY = 8;

export function shapeAutocomplete(raw: unknown): SpecialtyMatch[] {
  const results = (raw as { results?: RawAutocompleteResult[] })?.results ?? [];
  const out: SpecialtyMatch[] = [];
  for (const r of results) {
    if (!r.entity_id) continue;
    if (r.group_type === GROUP_DOCTOR_SPECIALTY) {
      const name = r.response_fields?.doctor_specialty_fields?.doctor_specialty_name;
      if (name) out.push({ id: r.entity_id, name, kind: 'doctor' });
    } else if (r.group_type === GROUP_FACILITY_SPECIALTY) {
      const name = r.response_fields?.facility_specialty_fields?.facility_specialty_name;
      if (name) out.push({ id: r.entity_id, name, kind: 'facility' });
    }
  }
  return out;
}

export interface FacetValue {
  /** Human-readable label, e.g. "Spanish". */
  value: string;
  /**
   * The exact string the corresponding search filter accepts, which is not
   * always the label: language facets are keyed by ISO code ("ES", not
   * "Spanish"), and a handful of hospital keys carry stray leading or trailing
   * spaces that upstream matches literally. Measured against a live network:
   * `language_code=ES` matched 2449 of 4772 PCPs while `language_code=Spanish`
   * matched 0, and one hospital name existed as two separate facets — with and
   * without a leading space — holding 1 provider and 141 respectively.
   */
  code: string;
  count: number;
}
export interface Facets {
  languages: FacetValue[];
  medicalGroups: FacetValue[];
  hospitalAffiliations: FacetValue[];
}

/**
 * Facet keys, observed in the live response: 1 = language, 6 = hospital
 * affiliation, 14 = medical group. (15 is present but always empty.) They are
 * numeric ids with no self-describing labels, hence this mapping.
 */
const FACET_LANGUAGE = '1';
const FACET_HOSPITAL = '6';
const FACET_MEDICAL_GROUP = '14';

interface RawFacetEntry { key?: string; display_str?: string; count?: number; }

function facetList(aggregations: Record<string, RawFacetEntry[]>, key: string): FacetValue[] {
  return (aggregations[key] ?? [])
    .map(e => ({
      value: (e.display_str ?? e.key ?? '').trim(),
      code: e.key ?? e.display_str ?? '',
      count: e.count ?? 0
    }))
    .filter(f => f.value.length > 0 && f.code.length > 0);
}

export function shapeFacets(raw: unknown): Facets {
  const aggregations = (raw as { aggregations?: Record<string, RawFacetEntry[]> })?.aggregations ?? {};
  return {
    languages: facetList(aggregations, FACET_LANGUAGE),
    medicalGroups: facetList(aggregations, FACET_MEDICAL_GROUP),
    hospitalAffiliations: facetList(aggregations, FACET_HOSPITAL)
  };
}

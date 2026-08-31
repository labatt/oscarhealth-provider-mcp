export interface RawLanguage { iso_code?: string; display_name_english?: string; }
export interface RawSpecialty { specialty_id?: string; specialty_name?: string; internal_specialty_display?: string; }
export interface RawAddress { address_line_1?: string; address_line_2?: string; city?: string; state?: string; zipcode?: string; }
export interface RawLocation { address?: RawAddress; distance_miles?: number; }
export interface RawOffice {
  office_name?: string; phone?: string; fax?: string;
  accepting_new_patients?: boolean; provider_office_id?: string; location?: RawLocation;
}
export interface RawCertification { board_description?: string; certification_description?: string; issue_year?: number; }
/**
 * Education field names verified against test/fixtures/doctors-page0.json. The
 * school is `institution_name` (not `school_name`) and the year arrives nested
 * as `graduation_date.year`, not a flat `graduation_year` — both are frequently
 * empty string / null upstream, so both are optional here.
 */
export interface RawGraduationDate { year?: number; month?: number; day?: number; }
export interface RawEducation {
  degree?: string;
  education_program?: string;
  institution_name?: string;
  graduation_date?: RawGraduationDate | null;
}
/** The licence's state arrives as `license_state`, not `state`. */
export interface RawLicense { license_state?: string; license_number?: string; }
export interface RawMemberFeedback {
  num_reviews?: number; percent_recommend?: number; top_provider?: boolean; can_show_reviews?: boolean;
}
export interface RawProvider {
  first_name?: string; middle_name?: string; last_name?: string;
  npi?: string; provider_id?: string; gender?: string;
  specialties?: RawSpecialty[]; languages?: RawLanguage[]; offices?: RawOffice[];
  certifications?: RawCertification[]; educations?: RawEducation[]; licenses?: RawLicense[];
  member_feedback?: RawMemberFeedback | null;
  years_experience?: number; cost_to_member_bucket?: number; pcp?: boolean;
}
export interface RawFacility {
  facility_id?: string; name?: string; phone?: string; website?: string;
  specialties?: RawSpecialty[]; accepting_new_patients?: boolean;
  wheelchair_accessible?: boolean; has_accreditation?: boolean; location?: RawLocation;
}
export interface RawAutocompleteResult {
  entity_id?: string;
  group_type?: number;
  response_fields?: {
    doctor_specialty_fields?: { doctor_specialty_name?: string };
    facility_specialty_fields?: { facility_specialty_name?: string };
  };
}

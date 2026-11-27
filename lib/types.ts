/**
 * Shared types for the DOT enricher.
 *
 * The vocabulary here is deliberately narrow: every field on `CarrierEnrichment`
 * maps either to something FMCSA publishes or to a status we computed ourselves.
 * Nothing is estimated, inferred or scraped from anywhere else.
 */

export type EnrichmentStatus =
  | 'enriched' // carrier found + phone/email/policy present
  | 'partial' // carrier found, but contact or insurance information is missing
  | 'not_found' // no FMCSA record for this DOT
  | 'invalid' // could not be parsed as a USDOT number
  | 'retry'; // upstream lookup failed (network / rate limit / 5xx)

export type LookupState = 'ok' | 'not_found' | 'error' | 'skipped' | 'disabled';

export type InsuranceKind = 'bipd' | 'cargo' | 'surety' | 'trust' | 'other';

export interface InsurancePolicy {
  /** Raw FMCSA form code, e.g. BMC-91X. */
  formCode: string | null;
  /** Raw FMCSA type code: 1 = BIPD, 2 = cargo, 3 = bond, 4 = trust fund. */
  typeCode: string | null;
  kind: InsuranceKind;
  /** Human label used in notes, e.g. "BIPD". */
  kindLabel: string;
  insurer: string | null;
  policyNumber: string | null;
  /** Maximum coverage in whole US dollars, when FMCSA publishes an amount. */
  coverage: number | null;
  /** Policy start date, ISO yyyy-mm-dd. */
  effectiveDate: string | null;
  /**
   * Date coverage ends, ISO yyyy-mm-dd. FMCSA only publishes this when the
   * insurer files a cancellation / termination notice — it is never derived.
   */
  cancellationDate: string | null;
  /** Date FMCSA received the filing, ISO yyyy-mm-dd. */
  transactionDate: string | null;
  /** True when no cancellation date is on file, or it is still in the future. */
  active: boolean;
  source: 'motus-insur' | 'motus-inshist';
}

export interface CarrierEnrichment {
  /** Normalised USDOT number (digits, no padding). */
  dot: string;
  status: EnrichmentStatus;
  legalName: string | null;
  dbaName: string | null;
  contactName: string | null;
  phone: string | null;
  /** E.164 form of the same phone number, when it is a resolvable US number. */
  phoneE164: string | null;
  email: string | null;
  /** Census "date added" / record creation, formatted in Eastern Time. */
  createdEdt: string | null;
  mcs150Date: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  usdotStatus: string | null;
  powerUnits: number | null;
  drivers: number | null;
  /** The policy surfaced in the required Policy Number / Effective / Expiration columns. */
  policy: InsurancePolicy | null;
  /** Every active-or-recent filing we saw, best first. */
  policies: InsurancePolicy[];
  /** Data sources that actually answered for this DOT. */
  sources: string[];
  /** Human readable explanations for blanks, corrections and warnings. */
  notes: string[];
  /** Required fields that came back empty. */
  missing: string[];
  /** True when FMCSA holds a value that we could not use as-is (e.g. a bare domain in the email field). */
  needsCorrection: boolean;
  lookup: {
    fmcsa: LookupState;
    census: LookupState;
    insurance: LookupState;
  };
  /** Milliseconds spent on this DOT, for the diagnostics panel. */
  elapsedMs?: number;
}

export interface EnrichResponse {
  results: CarrierEnrichment[];
  meta: {
    requested: number;
    returned: number;
    fmcsaConfigured: boolean;
    motusOk: boolean;
    /** False when any uploaded DOT remained unenriched ("retry") or MOTUS failed mid-batch. */
    complete?: boolean;
    /** Number of records still waiting for retry/enrichment. */
    pendingRetryCount?: number;
    elapsedMs: number;
    warnings: string[];
    /** Run-level explanation, present on server responses. */
    diagnosis?: {
      cause: string;
      severity: 'info' | 'warn' | 'error';
      title: string;
      detail: string;
      action: string | null;
      owner: 'you' | 'fmcsa' | 'nobody';
    };
  };
}

export interface ProviderStatus {
  fmcsa: {
    configured: boolean;
    /** Name of the environment variable the key was read from (never the key). */
    envVar: string | null;
    /** Last four characters, for confirming which key is live. */
    masked: string | null;
    baseUrl: string;
  };
  motus: {
    configured: boolean;
    envVar: string | null;
    baseUrl: string;
    datasets: Record<string, string>;
  };
  limits: {
    maxRowsPerFile: number;
    maxFileBytes: number;
    dotsPerRequest: number;
  };
  probe?: {
    ok: boolean;
    fmcsa?: { ok: boolean; latencyMs: number; message: string };
    motus?: { ok: boolean; latencyMs: number; message: string };
    diagnosis?: {
      code: string;
      message: string;
      status?: number;
      latencyMs?: number;
      envVar?: string | null;
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One carrier found by a lead search, shaped so every field maps to the column
 * the desk asked for. Values are copied from FMCSA or left null; nothing here is
 * derived, inferred or estimated.
 */
export interface LeadRow {
  /** USDOT number, digits only. */
  dot: string;
  /** MC / FF / MX docket (docket1 prefix + number). */
  docket: string | null;
  legalName: string | null;
  /** Census company officer (company_officer_1), title-cased. */
  officerName: string | null;
  /** Officer name split for dialer / CRM import. */
  firstName: string | null;
  lastName: string | null;
  dbaName: string | null;
  /** Physical state of the carrier — the column that drives the state filter. */
  state: string | null;
  city: string | null;
  physicalStreet: string | null;
  physicalZip: string | null;
  /** Mailing address; blank when the carrier filed none. */
  mailingStreet: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  phone: string | null;
  email: string | null;
  /** "Interstate" / "Intrastate" — FMCSA carrier_operation. */
  operation: string | null;
  /** Raw carrier_operation code (A / B / C), kept for the detail panel. */
  operationCode: string | null;
  /** Raw docket / census status code. */
  authorityStatus: string | null;
  /** Active / Inactive / Pending, spelled out. */
  authorityLabel: string | null;
  /** Census operating classification, e.g. "AUTHORIZED FOR HIRE". */
  classDef: string | null;
  /** Cargo ids from CARGO_TYPES. */
  cargo: string[];
  /** FMCSA's free-text "other cargo" description, when the carrier filed one. */
  cargoOther: string | null;
  /** Pre-formatted truck / trailer counts. */
  equipment: string | null;
  powerUnits: number | null;
  /** Date FMCSA registered the carrier — the lead's effective date. */
  addDate: string | null;
  mcs150Date: string | null;
  /** Best insurance filing: Carrier 1 / Policy Number 1 / Effective Date 1. */
  insurer: string | null;
  policyNumber: string | null;
  effectiveDate: string | null;
  /** Cancellation date of the filing — Expiring Date 1. */
  expiringDate: string | null;
  policyType: string | null;
  coverage: number | null;
  /** True when the carrier holds live cover today. */
  hasActiveCoverage: boolean;
  /**
   * Why this row matched the search: its policy effective date, its policy
   * expiring date, or (registration searches only) the carrier's current filing
   * when nothing fell inside the range.
   */
  matchReason: 'effective' | 'cancellation' | 'both' | 'current' | null;
  /** The date that placed this row in the result, ISO yyyy-mm-dd. */
  matchedDate: string | null;
  /** Which column(s) matched the active date filter(s). */
  matchDateKind: 'effective' | 'expiring' | 'both' | null;
  sources: string[];
  notes: string[];
}

export interface LeadSearchMeta {
  requested: number;
  returned: number;
  from: string | null;
  to: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  expiryFrom: string | null;
  expiryTo: string | null;
  limit: number;
  includeRejected: boolean;
  /** Carriers matching the census filters. */
  candidates: number | null;
  /** Insurance filings inside the date range. */
  filingsInRange: number | null;
  scanned: number;
  truncated: boolean;
  /** False when MOTUS rate-blocked or failed part of the batch, leaving carriers unverified. */
  complete: boolean;
  /** Carriers whose MOTUS detail lookup failed and could not be validated. */
  unenrichedCount: number;
  elapsedMs: number;
  mock: boolean;
  /** "policy": the range filters policy dates. "registration": census add dates. */
  dateMode: 'policy' | 'registration';
  /** Stage-by-stage accounting of where the census matches went. */
  funnel: import('./leads/funnel').LeadFunnel;
  warnings: string[];
  description: string;
}

/** The carriers behind one funnel drop, keyed by reason. */
export type RejectedLeads = Record<string, LeadRow[]>;

export interface LeadSearchResponse {
  rows: LeadRow[];
  meta: LeadSearchMeta;
  /**
   * Who was filtered out, per funnel reason, shaped like a lead row so the same
   * table and CSV can render them. Counts in `meta.funnel` are exact; a list
   * here may be capped, which `rejectedTruncated` flags.
   */
  rejected?: RejectedLeads;
  /** Reasons whose row list was cut short by the payload cap. */
  rejectedTruncated?: string[];
}

/**
 * Lead filters, saved profiles and the SoQL they turn into.
 *
 * Everything a user can type is normalised against a known vocabulary before it
 * becomes part of a query: state codes, cargo ids, operation and authority are
 * all resolved server-side from ids, so no filter value is ever interpolated
 * into SoQL as raw text.
 */

import { CARGO_TYPES, cargoExclusionClause, parseCargoList, TRUCK_TRACTOR_CLAUSE } from './cargo';
import { US_STATES, parseStateList } from './states';
import type { DateBound, LeadDateRanges } from './window';

export type InsuranceFilter = 'any' | 'yes' | 'no';
export type OperationFilter = 'any' | 'interstate' | 'intrastate';
export type PrivateFilter = 'exclude' | 'include' | 'only';
export type AuthorityStatusFilter = 'active' | 'any' | 'inactive' | 'pending';

export interface LeadFilters {
  /** Only carriers physically located in these states. Empty means every state. */
  states: string[];
  operation: OperationFilter;
  /** Authorized-for-hire carriers only (drops private fleets). */
  forHireOnly: boolean;
  privatePolicy: PrivateFilter;
  insurance: InsuranceFilter;
  authorityStatus: AuthorityStatusFilter;
  excludedStates: string[];
  /** Cargo ids from CARGO_TYPES that disqualify a carrier. */
  excludedCargo: string[];
  /** Case-insensitive phrases that must not appear in the legal or DBA name. */
  excludedKeywords: string[];
  /** Require at least one truck/tractor on the census record. */
  truckTractorOnly: boolean;
}

/**
 * The starting point for a trucking lead list: for-hire carriers with active
 * authority, no private fleets, no insurance on file (fresh authorities are the
 * ones worth contacting), household goods and other unwanted cargo removed, and
 * the five states this desk never works.
 */
export const DEFAULT_FILTERS: LeadFilters = {
  states: [],
  operation: 'any',
  forHireOnly: true,
  privatePolicy: 'exclude',
  insurance: 'no',
  authorityStatus: 'active',
  excludedStates: ['AK', 'CA', 'HI', 'NY', 'UT'],
  excludedCargo: [
    'household',
    'liquids',
    'passengers',
    'oilfield',
    'livestock',
    'mobilehome',
    'usmail',
    'chemicals',
    'construction',
    'waterwell',
  ],
  excludedKeywords: ['broker', 'freight forwarder', 'of household goods', 'passenger', 'mexican', 'boc-3', 'enterprise'],
  truckTractorOnly: true,
};

/* -------------------------------------------------------------------------- */
/* Normalising what a browser sends                                           */
/* -------------------------------------------------------------------------- */

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = String(value ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function stringList(value: unknown, max: number): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Case-insensitive phrase used in a `like` predicate; punctuation cannot survive. */
export function sanitiseKeyword(raw: unknown): string | null {
  const text = String(raw ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^A-Za-z0-9 .&'/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return text.length >= 2 ? text : null;
}

export function parseKeywords(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set<string>();
  for (const item of raw) {
    const keyword = sanitiseKeyword(item);
    if (!keyword) continue;
    seen.add(keyword.toLowerCase());
  }
  return [...seen].slice(0, 12);
}

/** Coerce anything (saved JSON, query string, request body) into valid filters. */
export function normaliseFilters(input: unknown): LeadFilters {
  const source = (input ?? {}) as Partial<Record<keyof LeadFilters, unknown>>;
  return {
    states: parseStateList(stringList(source.states, US_STATES.length).join(',')),
    operation: pickEnum(source.operation, ['any', 'interstate', 'intrastate'] as const, DEFAULT_FILTERS.operation),
    forHireOnly: boolOr(source.forHireOnly, DEFAULT_FILTERS.forHireOnly),
    privatePolicy: pickEnum(source.privatePolicy, ['exclude', 'include', 'only'] as const, DEFAULT_FILTERS.privatePolicy),
    insurance: pickEnum(source.insurance, ['any', 'yes', 'no'] as const, DEFAULT_FILTERS.insurance),
    authorityStatus: pickEnum(
      source.authorityStatus,
      ['active', 'any', 'inactive', 'pending'] as const,
      DEFAULT_FILTERS.authorityStatus,
    ),
    excludedStates: parseStateList(stringList(source.excludedStates, US_STATES.length).join(',')),
    excludedCargo: parseCargoList(stringList(source.excludedCargo, CARGO_TYPES.length)),
    excludedKeywords: parseKeywords(source.excludedKeywords),
    truckTractorOnly: boolOr(source.truckTractorOnly, DEFAULT_FILTERS.truckTractorOnly),
  };
}

/* -------------------------------------------------------------------------- */
/* SoQL                                                                       */
/* -------------------------------------------------------------------------- */

const compactDate = (iso: string) => iso.replace(/-/g, '');

/**
 * Census predicates.
 *
 * Authority status is read from the carrier's operating authority: the census
 * status code (`A` active, `I` inactive, `P` pending) and the MC docket status.
 * Carriers with no docket at all (purely intrastate, private fleets) are kept —
 * "no docket" is not a revoked authority.
 */
export function buildCensusWhere(filters: LeadFilters, options: { includeRejected: boolean }): string {
  const clauses: string[] = [];

  if (filters.states.length > 0) {
    clauses.push(`phy_state in(${filters.states.map((state) => `'${state}'`).join(',')})`);
  }

  if (filters.excludedStates.length > 0) {
    clauses.push(
      `(phy_state is null or phy_state not in(${filters.excludedStates.map((state) => `'${state}'`).join(',')}))`,
    );
  }

  if (filters.forHireOnly) {
    clauses.push(`classdef like '%FOR HIRE%'`);
  }

  switch (filters.privatePolicy) {
    case 'exclude':
      clauses.push(`(classdef is null or classdef not like '%PRIVATE PROPERTY%')`);
      break;
    case 'only':
      clauses.push(`classdef like '%PRIVATE PROPERTY%'`);
      break;
    default:
      break;
  }

  switch (filters.operation) {
    case 'interstate':
      clauses.push(`carrier_operation = 'A'`);
      break;
    case 'intrastate':
      clauses.push(`carrier_operation in('B','C')`);
      break;
    default:
      break;
  }

  switch (filters.authorityStatus) {
    case 'active':
      clauses.push(`status_code = 'A' and (docket1_status_code is null or docket1_status_code = 'A')`);
      break;
    case 'inactive':
      clauses.push(`(status_code = 'I' or docket1_status_code = 'I')`);
      break;
    case 'pending':
      clauses.push(`(status_code = 'P' or docket1_status_code = 'P')`);
      break;
    default:
      // "Any" still honours the rejected switch, so the two never contradict.
      if (!options.includeRejected) clauses.push(`status_code = 'A'`);
      break;
  }

  // A revoked docket is a rejected authority, whatever the census status says.
  if (!options.includeRejected) {
    clauses.push(`(docket1_status_code is null or docket1_status_code != 'I')`);
  }

  const cargo = cargoExclusionClause(filters.excludedCargo);
  if (cargo) clauses.push(cargo);

  if (filters.truckTractorOnly) clauses.push(TRUCK_TRACTOR_CLAUSE);

  for (const keyword of filters.excludedKeywords) {
    const escaped = keyword.replace(/'/g, "''");
    clauses.push(`legal_name not like '%${escaped}%'`);
    clauses.push(`(dba_name is null or dba_name not like '%${escaped}%')`);
  }

  return clauses.length > 0 ? clauses.join(' and ') : 'dot_number is not null';
}

/** The census date predicate — registration ("effective") date in the range. */
export function censusDateClause(from: string, to: string): string {
  return `add_date between '${compactDate(from)}' and '${compactDate(to)}'`;
}

/**
 * Build a SoQL date predicate for an 8-digit compact date column (`yyyymmdd`),
 * supporting closed (`between`), lower-bounded (`>=`), or upper-bounded (`<=`) ranges.
 */
export function buildDateBoundClause(column: string, bound?: DateBound | null): string | null {
  if (!bound) return null;
  const start = bound.from ? compactDate(bound.from).replace(/\D/g, '').slice(0, 8) : '';
  const end = bound.to ? compactDate(bound.to).replace(/\D/g, '').slice(0, 8) : '';
  const hasStart = start.length === 8;
  const hasEnd = end.length === 8;
  if (hasStart && hasEnd) return `${column} between '${start}' and '${end}'`;
  if (hasStart) return `${column} >= '${start}'`;
  if (hasEnd) return `${column} <= '${end}'`;
  return null;
}

/**
 * Insurance date predicate for separate Effective and Expiry ranges.
 * When both ranges are populated, a filing must satisfy both on the same row.
 */
export function buildInsuranceRangesWhere(ranges: LeadDateRanges): string | null {
  const effClause = buildDateBoundClause('effective_date', ranges.effective);
  const expClause = buildDateBoundClause('cancl_effective_date', ranges.expiry);
  if (effClause && expClause) return `(${effClause}) and (${expClause})`;
  return effClause ?? expClause ?? null;
}

/**
 * Legacy single-window insurance date predicate.
 *
 * A policy qualifies when it took effect inside the range (new business) or when
 * it expires inside the range (a cancellation the insurer has already filed, so
 * the carrier is about to need cover).
 */
export function buildInsuranceWhere(from: string, to: string): string {
  const start = compactDate(from);
  const end = compactDate(to);
  return `(effective_date between '${start}' and '${end}') or (cancl_effective_date between '${start}' and '${end}')`;
}

/* -------------------------------------------------------------------------- */
/* Human summaries                                                            */
/* -------------------------------------------------------------------------- */

const PRIVATE_LABEL: Record<PrivateFilter, string> = {
  exclude: 'Private excluded',
  include: 'Private included',
  only: 'Private only',
};

const AUTHORITY_LABEL: Record<AuthorityStatusFilter, string> = {
  active: 'Active authority',
  any: 'Any authority status',
  inactive: 'Inactive authority',
  pending: 'Pending authority',
};

const OPERATION_LABEL: Record<OperationFilter, string> = {
  any: 'Any operation',
  interstate: 'Interstate',
  intrastate: 'Intrastate',
};

/** One compact line that describes the whole filter set, as the desk reads it. */
export function describeFilters(filters: LeadFilters): string {
  const parts: string[] = [];

  if (filters.states.length > 0) {
    parts.push(
      filters.states.length === 1 ? `State: ${filters.states[0]}` : `States: ${filters.states.join(', ')}`,
    );
  }
  if (filters.forHireOnly) parts.push('For hire');
  parts.push(OPERATION_LABEL[filters.operation]);
  parts.push(PRIVATE_LABEL[filters.privatePolicy].toLowerCase());
  parts.push(AUTHORITY_LABEL[filters.authorityStatus]);
  if (filters.insurance !== 'any') parts.push(`Insurance: ${filters.insurance === 'yes' ? 'Yes' : 'No'}`);
  if (filters.truckTractorOnly) parts.push('Truck tractor');
  if (filters.excludedStates.length > 0) {
    parts.push(`${filters.excludedStates.length} state${filters.excludedStates.length === 1 ? '' : 's'} excluded`);
  }
  if (filters.excludedCargo.length > 0) {
    parts.push(`${filters.excludedCargo.length} cargo type${filters.excludedCargo.length === 1 ? '' : 's'} excluded`);
  }
  if (filters.excludedKeywords.length > 0) {
    parts.push(`${filters.excludedKeywords.length} keyword${filters.excludedKeywords.length === 1 ? '' : 's'} excluded`);
  }

  return parts.join(' · ');
}

/** True when the filters differ from the shipped defaults. */
export function filtersAreCustom(filters: LeadFilters): boolean {
  const keys = Object.keys(DEFAULT_FILTERS) as Array<keyof LeadFilters>;
  return keys.some((key) => {
    const a = filters[key];
    const b = DEFAULT_FILTERS[key];
    if (Array.isArray(a) && Array.isArray(b)) return a.join(',') !== b.join(',');
    return a !== b;
  });
}

/* -------------------------------------------------------------------------- */
/* Lead categories                                                            */
/* -------------------------------------------------------------------------- */

export interface LeadCategory {
  id: string;
  label: string;
  /** One line shown under the select. */
  hint: string;
  /** Filter values this category applies on top of the current list. */
  patch: Partial<LeadFilters>;
}

/**
 * Presets for the "Lead Category" select. Each one only changes the switches it
 * names, so a category can be picked without wiping a hand-edited keyword list.
 */
export const LEAD_CATEGORIES: readonly LeadCategory[] = [
  {
    id: 'new_authority',
    label: 'New Authority Leads',
    hint: 'For-hire carriers, active authority, no insurance filed yet — the usual new-authority list.',
    patch: { forHireOnly: true, authorityStatus: 'active', insurance: 'no', privatePolicy: 'exclude' },
  },
  {
    id: 'all_active',
    label: 'All Active Carriers',
    hint: 'Every active authority matching the filters, insured or not.',
    patch: { forHireOnly: true, authorityStatus: 'active', insurance: 'any', privatePolicy: 'exclude' },
  },
  {
    id: 'insured',
    label: 'Insured Carriers',
    hint: 'Active carriers with live insurance on file at FMCSA.',
    patch: { forHireOnly: true, authorityStatus: 'active', insurance: 'yes', privatePolicy: 'exclude' },
  },
  {
    id: 'private_fleet',
    label: 'Private Fleets',
    hint: 'Private property carriers — own-goods fleets rather than for-hire authority.',
    patch: { forHireOnly: false, privatePolicy: 'only', authorityStatus: 'any', insurance: 'any' },
  },
  {
    id: 'inactive',
    label: 'Inactive / Rejected Authority',
    hint: 'Inactive or pending authority — useful for win-back lists.',
    patch: { authorityStatus: 'inactive', insurance: 'any' },
  },
];

export function findCategory(id: string): LeadCategory | null {
  return LEAD_CATEGORIES.find((category) => category.id === id) ?? null;
}

export function applyCategory(filters: LeadFilters, id: string): LeadFilters {
  const category = findCategory(id);
  if (!category) return filters;
  return { ...filters, ...category.patch };
}

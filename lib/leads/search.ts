/**
 * Lead search against FMCSA's public open-data files.
 *
 * Two datasets are read:
 *   1. Company Census File (az4n-8mr2) — identity, address, contact, operation,
 *      authority, cargo and equipment. Its ADD_DATE is when FMCSA registered the
 *      carrier, which is the census "effective date" of a new-authority lead.
 *   2. Motus Insur (c5y8-a4uz) and Motus InsHist (3uet-3z4i) — insurer, policy
 *      number, effective date and (InsHist only) the cancellation date that
 *      becomes the lead's expiring date.
 *
 * Effective Date (From / To) and Expiry Date (From / To) are independent filters:
 *   - Effective range only: matches policy effective date (or census add_date in
 *     registration mode).
 *   - Expiry range only: matches policy cancellation / expiring date.
 *   - Both Effective and Expiry ranges set: a row must satisfy both ranges.
 *
 * Requests are paced per host with automatic post-403 cooldowns (lib/http.ts),
 * duplicate DOTs and duplicate filings are collapsed, and any carrier whose
 * MOTUS lookup failed is tracked as `lookup_failed` (`complete: false`) rather
 * than being silently dropped as uninsured or allowing an incomplete batch to
 * masquerade as complete.
 */

import { MOTUS_BASE_URL, MOTUS_DATASETS, isMockMode, isMotusEnabled, resolveMotusToken } from '../env';
import { fetchJson } from '../http';
import { parseCoverage, parseFmcsaDate, todayIso } from '../normalize';
import type { LeadRow } from '../types';
import { CARGO_TYPES, cargoFromRow, equipmentSummary, operationLabel } from './cargo';
import {
  buildCensusWhere,
  buildDateBoundClause,
  buildInsuranceRangesWhere,
  buildInsuranceWhere,
  type LeadFilters,
} from './filters';
import {
  compact,
  compareLeads,
  hasDateBound,
  selectPolicy,
  sortKey,
  withinDateBound,
  withinWindow,
  type DateBound,
  type LeadDateRanges,
  type SelectedPolicy,
} from './window';
import { fullOfficerName, splitOfficerName } from './personName';
import { buildFunnel, type DropReason, type LeadFunnel } from './funnel';

type Row = Record<string, unknown>;

const ACTIVE_FILING_COLUMNS =
  'usdot_number,policy_no,effective_date,insurance_company_name,ins_form_code,max_cov_amount';
const INSURANCE_FILING_COLUMNS =
  'usdot_number,policy_no,effective_date,cancl_effective_date,insurance_company_name,ins_form_code,max_cov_amount';
const CENSUS_PAGE = 1000;
const INSURANCE_PAGE = 1000;
const POLICY_CHUNK = 120;
/** Census records read per pass, so one slow page cannot eat the whole run. */
const MAX_CENSUS_ROWS = 12_000;
/** Filing records read in Pass 2 before census join, paginated so filters cannot starve counts. */
const MAX_FILING_ROWS = 8_000;
/** Upper bound on Motus policy lookup chunks for one preview (60 × 120 = 7,200 DOTs). */
const MAX_INSURANCE_LOOKUPS = 60;

const CENSUS_COLUMNS = [
  'dot_number',
  'docket1prefix',
  'docket1',
  'docket1_status_code',
  'legal_name',
  'company_officer_1',
  'dba_name',
  'phy_street',
  'phy_city',
  'phy_state',
  'phy_zip',
  'carrier_mailing_street',
  'carrier_mailing_city',
  'carrier_mailing_state',
  'carrier_mailing_zip',
  'phone',
  'email_address',
  'carrier_operation',
  'classdef',
  'status_code',
  'truck_units',
  'power_units',
  'owntract',
  'trmtract',
  'owntrail',
  'trmtrail',
  'add_date',
  'mcs150_date',
  'crgo_cargoothr_desc',
  ...CARGO_TYPES.map((type) => type.column).filter((column): column is string => Boolean(column)),
].join(',');

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function digits(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  const only = s.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return only.length > 0 ? only : null;
}

function num(value: unknown): number | null {
  const s = text(value);
  if (!s) return null;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function sum(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0);
}

function datasetUrl(dataset: string, params: Record<string, string>): string {
  const url = new URL(`${MOTUS_BASE_URL}/${dataset}.json`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const token = resolveMotusToken();
  if (token) url.searchParams.set('$$app_token', token.key);
  return url.toString();
}

async function countRows(dataset: string, where: string, signal?: AbortSignal): Promise<number | null> {
  const result = await fetchJson<Row[]>(datasetUrl(dataset, { $select: 'count(*) as n', $where: where }), {
    signal,
    timeoutMs: 15_000,
    retries: 2,
  });
  if (!result.ok || !Array.isArray(result.data)) return null;
  return num(result.data[0]?.n);
}

interface SelectDatasetOutcome {
  rows: Row[] | null;
  error: string | null;
  rateLimited: boolean;
}

async function selectRowsWithOutcome(
  dataset: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<SelectDatasetOutcome> {
  const result = await fetchJson<Row[]>(datasetUrl(dataset, params), {
    signal,
    timeoutMs: 25_000,
    retries: 2,
  });
  return {
    rows: result.ok && Array.isArray(result.data) ? result.data : null,
    error: result.error,
    rateLimited: Boolean(result.rateLimited),
  };
}

async function selectRows(
  dataset: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Row[] | null> {
  const outcome = await selectRowsWithOutcome(dataset, params, signal);
  return outcome.rows;
}

/* -------------------------------------------------------------------------- */
/* Policy index                                                               */
/* -------------------------------------------------------------------------- */

function filingDedupeKey(dot: string, row: Row): string {
  return [
    dot,
    text(row.policy_no) ?? '',
    compact(text(row.effective_date)),
    compact(text(row.cancl_effective_date)),
    text(row.ins_form_code) ?? '',
  ].join('|');
}

/**
 * Fetch every filing for the given carriers, grouped by USDOT.
 *
 * Paced sequentially per dataset rather than concurrent bursts so Akamai / MOTUS
 * rate controls do not return HTTP 403. Tracks `failedDots` whenever a lookup
 * fails or times out so unenriched carriers are never misclassified as having
 * no insurance or allowed into a "complete" batch.
 */
async function fetchFilings(
  dots: readonly string[],
  signal?: AbortSignal,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ byDot: Map<string, Row[]>; failedDots: Set<string>; failed: boolean; lastError: string | null }> {
  const uniqueDots = [...new Set(dots.map((d) => digits(d)).filter((d): d is string => Boolean(d)))];
  const byDot = new Map<string, Row[]>();
  const seenFilings = new Set<string>();
  const failedDots = new Set<string>();
  let failed = false;
  let lastError: string | null = null;
  let lookups = 0;

  for (let i = 0; i < uniqueDots.length; i += POLICY_CHUNK) {
    const chunk = uniqueDots.slice(i, i + POLICY_CHUNK);
    if (signal?.aborted || lookups >= MAX_INSURANCE_LOOKUPS || Date.now() > deadline) {
      failed = true;
      if (!lastError) {
        lastError =
          lookups >= MAX_INSURANCE_LOOKUPS
            ? 'Reached the per-run MOTUS lookup safety cap before all candidates were checked.'
            : 'MOTUS lookup window timed out before all candidates were checked.';
      }
      for (const dot of uniqueDots.slice(i)) failedDots.add(dot);
      break;
    }

    lookups += 1;
    const inList = chunk.map((dot) => `'${dot}'`).join(',');
    const active = await selectRowsWithOutcome(
      MOTUS_DATASETS.insurance,
      { $where: `usdot_number in(${inList})`, $limit: '5000' },
      signal,
    );
    const history = await selectRowsWithOutcome(
      MOTUS_DATASETS.insuranceHistory,
      { $where: `usdot_number in(${inList})`, $limit: '5000' },
      signal,
    );

    if (!active.rows || !history.rows) {
      failed = true;
      lastError = active.error ?? history.error ?? lastError;
      for (const dot of chunk) failedDots.add(dot);
    }

    for (const row of [...(active.rows ?? []), ...(history.rows ?? [])]) {
      const dot = digits(row.usdot_number);
      if (!dot) continue;
      const key = filingDedupeKey(dot, row);
      if (seenFilings.has(key)) continue;
      seenFilings.add(key);
      const list = byDot.get(dot) ?? [];
      list.push(row);
      byDot.set(dot, list);
    }
  }

  return { byDot, failedDots, failed, lastError };
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * MC docket as the desk wants it: prefix + number ("MC100480").
 */
function docketNumber(row: Row): string | null {
  const prefix = text(row.docket1prefix)?.toUpperCase() ?? null;
  const number = digits(row.docket1);
  if (!number) return null;
  return prefix ? `${prefix}${number}` : `MC${number}`;
}

function stateCode(value: unknown): string | null {
  const s = text(value)?.toUpperCase() ?? null;
  return s && /^[A-Z]{2}$/.test(s) ? s : null;
}

function authorityLabel(censusStatus: string | null, docketStatus: string | null): string | null {
  const docket = docketStatus?.toUpperCase() ?? null;
  if (docket === 'A') return 'Active';
  if (docket === 'I') return 'Inactive';
  if (docket === 'P') return 'Pending';

  const status = censusStatus?.toUpperCase() ?? null;
  if (status === 'A') return 'Active';
  if (status === 'I') return 'Inactive';
  if (status === 'P') return 'Pending';
  return null;
}

function buildNotes(census: Row, selected: SelectedPolicy, today: string): string[] {
  const notes: string[] = [];
  const filing = selected.filing;

  if (!filing) {
    notes.push('No insurance filing on FMCSA for this carrier — checked both Motus Insur and InsHist.');
  } else {
    if (!text(filing.policy_no)) notes.push('FMCSA lists an insurer but no policy number for this carrier.');
    if (!text(filing.effective_date)) notes.push('FMCSA holds no effective date for this policy.');

    if (selected.reason === 'both') {
      notes.push('The policy shown matched both the selected effective date range and expiry date range.');
    } else if (selected.reason === 'cancellation') {
      notes.push(
        'The policy shown is the one expiring inside the selected expiry date range.',
      );
    } else if (selected.reason === 'current') {
      notes.push('Policy shown is the carrier’s current filing; it falls outside the selected dates.');
    }

    const expiring = text(filing.cancl_effective_date);
    if (!expiring) {
      notes.push(
        'No cancellation filed, so the expiring date is blank — FMCSA only publishes one when an insurer files it.',
      );
    }
    if (!selected.hasActiveCoverage) {
      notes.push('Every filing on this carrier has a cancellation date in the past, so cover has lapsed.');
    }
  }

  if (!text(census.docket1)) {
    notes.push(
      'FMCSA issues no MC docket for this carrier yet — the authority is pending or it operates as a USDOT-only carrier.',
    );
  }
  if (!text(census.company_officer_1)) {
    notes.push('FMCSA publishes no company officer name for this carrier.');
  }

  if (!text(census.email_address)) notes.push('FMCSA publishes no email address for this carrier.');
  if (!text(census.phone)) notes.push('FMCSA publishes no phone number for this carrier.');
  if (!text(census.carrier_mailing_street)) {
    notes.push('No mailing address filed; the street, city and ZIP columns fall back to the physical address.');
  }

  const mcs = parseFmcsaDate(census.mcs150_date);
  const todayYear = Number(today.slice(0, 4));
  if (mcs && todayYear && Number(mcs.slice(0, 4)) < todayYear - 2) {
    notes.push(`MCS-150 not updated since ${mcs}; the census record may be stale.`);
  }

  return notes;
}

/**
 * One export row. Carrier 1 / Policy Number 1 / Effective Date 1 / Expiring
 * Date 1 all come from the same filing — the one that matched the date filter(s) —
 * so the dates on screen always explain why the row is there.
 */
export function mapLeadRow(census: Row, selected: SelectedPolicy, today: string): LeadRow | null {
  const dot = digits(census.dot_number);
  if (!dot) return null;

  const filing = selected.filing;
  const matchDateKind: LeadRow['matchDateKind'] =
    selected.reason === 'both'
      ? 'both'
      : selected.reason === 'cancellation'
        ? 'expiring'
        : selected.reason === 'effective'
          ? 'effective'
          : null;

  return {
    dot,
    docket: docketNumber(census),
    legalName: text(census.legal_name),
    /** Census company officer — the only person FMCSA publishes for a carrier. */
    officerName: fullOfficerName(text(census.company_officer_1)),
    ...splitOfficerName(text(census.company_officer_1)),
    dbaName: text(census.dba_name),
    state: stateCode(census.phy_state),
    city: text(census.phy_city),
    physicalStreet: text(census.phy_street),
    physicalZip: text(census.phy_zip),
    mailingStreet: text(census.carrier_mailing_street),
    mailingCity: text(census.carrier_mailing_city),
    mailingState: stateCode(census.carrier_mailing_state),
    mailingZip: text(census.carrier_mailing_zip),
    phone: text(census.phone),
    email: text(census.email_address),
    operation: operationLabel(text(census.carrier_operation)),
    operationCode: text(census.carrier_operation),
    authorityStatus: text(census.docket1_status_code) ?? text(census.status_code),
    authorityLabel: authorityLabel(text(census.status_code), text(census.docket1_status_code)),
    classDef: text(census.classdef),
    cargo: cargoFromRow(census),
    cargoOther: text(census.crgo_cargoothr_desc),
    equipment: equipmentSummary({
      trucks: num(census.truck_units) ?? num(census.power_units),
      tractors: sum([num(census.owntract), num(census.trmtract)]),
      trailers: sum([num(census.owntrail), num(census.trmtrail)]),
    }),
    powerUnits: num(census.power_units),
    addDate: parseFmcsaDate(census.add_date),
    mcs150Date: parseFmcsaDate(census.mcs150_date),
    insurer: text(filing?.insurance_company_name),
    policyNumber: text(filing?.policy_no),
    effectiveDate: parseFmcsaDate(filing?.effective_date),
    expiringDate: parseFmcsaDate(filing?.cancl_effective_date),
    policyType: text(filing?.ins_form_code),
    coverage: parseCoverage(filing?.max_cov_amount),
    hasActiveCoverage: selected.hasActiveCoverage,
    matchReason: selected.reason,
    matchedDate: selected.matchedDate,
    matchDateKind,
    sources: ['FMCSA Company Census File', 'Motus Insur', 'Motus InsHist'],
    notes: buildNotes(census, selected, today),
  };
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

export interface LeadSearchInput {
  filters: LeadFilters;
  /** Legacy single-window start, ISO yyyy-mm-dd. */
  from?: string;
  /** Legacy single-window end, ISO yyyy-mm-dd. */
  to?: string;
  /** Separate Effective Date range (policy effective_date or census add_date). */
  effective?: DateBound;
  /** Separate Expiry Date range (policy cancl_effective_date). */
  expiry?: DateBound;
  limit: number;
  includeRejected: boolean;
  signal?: AbortSignal;
}

export interface LeadSearchResult {
  rows: LeadRow[];
  ok: boolean;
  error?: string;
  warnings: string[];
  /** Carriers matching the census filters, before the insurance step. */
  candidates: number | null;
  /** Insurance filings inside the window(s). */
  filingsInRange: number | null;
  scanned: number;
  truncated: boolean;
  /** False when MOTUS failed/throttled part of the batch so carriers remained unverified. */
  complete: boolean;
  /** Count of candidate carriers whose MOTUS lookup could not be completed. */
  unenrichedCount: number;
  /** Which side of the date range was applied. */
  dateMode: DateMode;
  /** Normalised Effective and Expiry date bounds used by the search. */
  ranges: LeadDateRanges;
  /** Where the carriers went: how many survived each stage and why the rest left. */
  funnel: LeadFunnel;
  /**
   * The carriers behind each funnel drop, shaped like a lead row so the same
   * table and CSV can show them. Capped; `rejectedTruncated` says when.
   */
  rejected: Partial<Record<DropReason, LeadRow[]>>;
  /** Reasons whose row list was cut off by the cap. */
  rejectedTruncated: DropReason[];
  elapsedMs: number;
}

const EMPTY_RANGES: LeadDateRanges = {
  effective: { from: null, to: null },
  expiry: { from: null, to: null },
};

function emptyResult(
  started: number,
  error: string,
  ranges: LeadDateRanges = EMPTY_RANGES,
  unenrichedCount = 0,
): LeadSearchResult {
  return {
    rows: [],
    ok: false,
    error,
    warnings: [],
    candidates: null,
    filingsInRange: null,
    scanned: 0,
    truncated: false,
    complete: false,
    unenrichedCount,
    dateMode: 'registration',
    ranges,
    funnel: buildFunnel({
      dateMode: 'registration',
      censusCount: null,
      inspected: 0,
      drops: {},
      returned: 0,
      matched: 0,
      limit: 0,
    }),
    rejected: {},
    rejectedTruncated: [],
    elapsedMs: Date.now() - started,
  };
}

export type DateMode = 'registration' | 'policy';

export function resolveDateMode(filters: LeadFilters, ranges?: LeadDateRanges): DateMode {
  if (filters.insurance === 'no') {
    if (ranges && !hasDateBound(ranges.effective) && hasDateBound(ranges.expiry)) {
      return 'policy';
    }
    return 'registration';
  }
  return 'policy';
}

interface ResolvedInputRanges {
  ranges: LeadDateRanges;
  legacyWindow: { from: string; to: string } | null;
}

export function resolveSearchRanges(input: LeadSearchInput): ResolvedInputRanges {
  if (input.effective !== undefined || input.expiry !== undefined) {
    return {
      ranges: {
        effective: {
          from: input.effective?.from ?? null,
          to: input.effective?.to ?? null,
        },
        expiry: {
          from: input.expiry?.from ?? null,
          to: input.expiry?.to ?? null,
        },
      },
      legacyWindow: null,
    };
  }
  const from = input.from ?? null;
  const to = input.to ?? null;
  return {
    ranges: {
      effective: { from, to },
      expiry: { from: null, to: null },
    },
    legacyWindow: from && to ? { from, to } : null,
  };
}

const REJECTED_CAP_PER_REASON = 3000;

interface Candidate {
  record: Row;
  windowFiling?: Row;
}

/**
 * Paginate an insurance dataset for DOTs matching `where`, joining each page
 * against the census `censusWhere` filter until `goal` matching candidates are
 * collected or `MAX_FILING_ROWS` is reached.
 */
async function collectFilingDrivenCandidates(args: {
  dataset: string;
  select: string;
  where: string;
  order: string;
  censusWhere: string;
  candidates: Map<string, Candidate>;
  goal: number;
  signal?: AbortSignal;
}): Promise<{ responded: boolean; error: string | null }> {
  const { dataset, select, where, order, censusWhere, candidates, goal, signal } = args;
  let offset = 0;
  let responded = false;
  let lastError: string | null = null;
  let added = 0;
  const seenFilingDots = new Set<string>();

  while (offset < MAX_FILING_ROWS && added < goal && !signal?.aborted) {
    const page = await selectRowsWithOutcome(
      dataset,
      {
        $select: select,
        $where: where,
        $order: order,
        $limit: String(INSURANCE_PAGE),
        $offset: String(offset),
      },
      signal,
    );

    if (!page.rows) {
      lastError = page.error;
      break;
    }

    responded = true;
    offset += page.rows.length;

    const pageFilings = new Map<string, Row>();
    for (const filing of page.rows) {
      const dot = digits(filing.usdot_number);
      if (!dot || candidates.has(dot) || seenFilingDots.has(dot) || pageFilings.has(dot)) continue;
      seenFilingDots.add(dot);
      pageFilings.set(dot, filing);
    }

    const newDots = [...pageFilings.keys()];
    for (let i = 0; i < newDots.length && added < goal && !signal?.aborted; i += POLICY_CHUNK) {
      const chunk = newDots.slice(i, i + POLICY_CHUNK);
      const batch = await selectRows(
        MOTUS_DATASETS.census,
        {
          $select: CENSUS_COLUMNS,
          $where: `${censusWhere} and dot_number in(${chunk.map((dot) => `'${dot}'`).join(',')})`,
          $limit: String(POLICY_CHUNK),
        },
        signal,
      );
      for (const record of batch ?? []) {
        const dot = digits(record.dot_number);
        if (!dot || candidates.has(dot)) continue;
        candidates.set(dot, { record, windowFiling: pageFilings.get(dot) });
        added += 1;
      }
    }

    if (page.rows.length < INSURANCE_PAGE) break;
  }

  return { responded, error: lastError };
}

export async function searchLeads(input: LeadSearchInput): Promise<LeadSearchResult> {
  const started = Date.now();
  const { filters, limit, includeRejected, signal } = input;
  const { ranges, legacyWindow } = resolveSearchRanges(input);
  const warnings: string[] = [];

  if (isMockMode()) return mockSearch(input, ranges, legacyWindow);
  if (!isMotusEnabled()) {
    return emptyResult(started, 'Public FMCSA open-data lookups are disabled (MOTUS_ENABLED=0).', ranges);
  }

  const hasEffective = hasDateBound(ranges.effective);
  const hasExpiry = hasDateBound(ranges.expiry);
  if (!legacyWindow && !hasEffective && !hasExpiry) {
    return emptyResult(started, 'Choose at least an Effective Date range or an Expiry Date range.', ranges);
  }

  const today = todayIso();
  const todayCompact = compact(today);
  const target = Math.min(Math.max(limit, 1), 2000);
  const mode = resolveDateMode(filters, ranges);

  const baseWhere = buildCensusWhere(filters, { includeRejected });
  const censusEffClause = buildDateBoundClause('add_date', ranges.effective);
  const censusDateWhere = censusEffClause ? `${baseWhere} and ${censusEffClause}` : null;

  /* Count census candidates & insurance filings in range (paced via fetchJson) */
  let censusCount: number | null = null;
  if (censusDateWhere) {
    censusCount = await countRows(MOTUS_DATASETS.census, censusDateWhere, signal);
    if (censusCount === null) {
      return emptyResult(
        started,
        'The FMCSA Company Census File did not respond (it may be temporarily rate-limiting requests). Try again in a moment.',
        ranges,
      );
    }
  }

  let filingCount: number | null = null;
  if (legacyWindow) {
    filingCount = await countRows(
      MOTUS_DATASETS.insuranceHistory,
      buildInsuranceWhere(legacyWindow.from, legacyWindow.to),
      signal,
    );
  } else {
    const effFilingClause = buildDateBoundClause('effective_date', ranges.effective);
    const combinedWhere = buildInsuranceRangesWhere(ranges);
    if (hasEffective && !hasExpiry && effFilingClause) {
      const activeCount = await countRows(MOTUS_DATASETS.insurance, effFilingClause, signal);
      const histCount = await countRows(MOTUS_DATASETS.insuranceHistory, effFilingClause, signal);
      filingCount = activeCount !== null || histCount !== null ? (activeCount ?? 0) + (histCount ?? 0) : null;
    } else if (combinedWhere) {
      filingCount = await countRows(MOTUS_DATASETS.insuranceHistory, combinedWhere, signal);
    }
  }

  const candidates = new Map<string, Candidate>();
  let scanned = 0;

  /* Filing-driven pass — runs first whenever an Expiry range is active or in
     policy mode so policy-matching carriers are never starved by uninsured
     census rows. Paginates through MOTUS filings instead of stopping at 400. - */
  if ((mode === 'policy' || hasExpiry) && !signal?.aborted) {
    const censusConstraint = mode === 'registration' && censusDateWhere ? censusDateWhere : baseWhere;

    if (legacyWindow) {
      const compactFrom = compact(legacyWindow.from);
      const compactTo = compact(legacyWindow.to);
      const effOutcome = await collectFilingDrivenCandidates({
        dataset: MOTUS_DATASETS.insuranceHistory,
        select: INSURANCE_FILING_COLUMNS,
        where: `effective_date between '${compactFrom}' and '${compactTo}'`,
        order: 'effective_date asc',
        censusWhere: censusConstraint,
        candidates,
        goal: target * 2,
        signal,
      });
      const expOutcome = await collectFilingDrivenCandidates({
        dataset: MOTUS_DATASETS.insuranceHistory,
        select: INSURANCE_FILING_COLUMNS,
        where: `cancl_effective_date between '${compactFrom}' and '${compactTo}'`,
        order: 'cancl_effective_date asc',
        censusWhere: censusConstraint,
        candidates,
        goal: target * 2,
        signal,
      });
      if (!effOutcome.responded && !expOutcome.responded) {
        warnings.push('MOTUS insurance filing search did not respond, so results come from census dates only.');
      }
    } else if (hasEffective && hasExpiry) {
      // Both Effective and Expiry ranges set: in policy mode, both must sit on
      // the same filing in InsHist; in registration mode, census add_date is in
      // `censusConstraint` and expiring date is in InsHist.
      const where =
        mode === 'policy'
          ? buildInsuranceRangesWhere(ranges)!
          : buildDateBoundClause('cancl_effective_date', ranges.expiry)!;
      const order = mode === 'policy' ? 'effective_date asc' : 'cancl_effective_date asc';
      const outcome = await collectFilingDrivenCandidates({
        dataset: MOTUS_DATASETS.insuranceHistory,
        select: INSURANCE_FILING_COLUMNS,
        where,
        order,
        censusWhere: censusConstraint,
        candidates,
        goal: target * 2,
        signal,
      });
      if (!outcome.responded) {
        return emptyResult(
          started,
          outcome.error ??
            'MOTUS insurance history did not respond, so expiry date eligibility could not be validated. Wait a moment and retry.',
          ranges,
        );
      }
    } else if (!hasEffective && hasExpiry) {
      const expWhere = buildDateBoundClause('cancl_effective_date', ranges.expiry)!;
      const outcome = await collectFilingDrivenCandidates({
        dataset: MOTUS_DATASETS.insuranceHistory,
        select: INSURANCE_FILING_COLUMNS,
        where: expWhere,
        order: 'cancl_effective_date asc',
        censusWhere: censusConstraint,
        candidates,
        goal: target * 2,
        signal,
      });
      if (!outcome.responded) {
        return emptyResult(
          started,
          outcome.error ??
            'MOTUS insurance history did not respond, so expiry date eligibility could not be validated. Wait a moment and retry.',
          ranges,
        );
      }
    } else if (hasEffective && !hasExpiry && mode === 'policy') {
      const effWhere = buildDateBoundClause('effective_date', ranges.effective)!;
      const activeOutcome = await collectFilingDrivenCandidates({
        dataset: MOTUS_DATASETS.insurance,
        select: ACTIVE_FILING_COLUMNS,
        where: effWhere,
        order: 'effective_date asc',
        censusWhere: baseWhere,
        candidates,
        goal: target * 2,
        signal,
      });
      const histOutcome = await collectFilingDrivenCandidates({
        dataset: MOTUS_DATASETS.insuranceHistory,
        select: INSURANCE_FILING_COLUMNS,
        where: effWhere,
        order: 'effective_date asc',
        censusWhere: baseWhere,
        candidates,
        goal: target * 2,
        signal,
      });
      if (!activeOutcome.responded && !histOutcome.responded) {
        warnings.push('MOTUS insurance filing list did not respond; falling back to census registration dates.');
      }
    }
  }

  /* Census registration pass — runs when an Effective date range is present so
     registration searches work and policy searches still show the census funnel. */
  const censusGoal = hasEffective && hasExpiry ? target * 2 : Math.max(target * 2, candidates.size + target);
  if (censusDateWhere && !signal?.aborted) {
    let offset = 0;
    while (scanned < MAX_CENSUS_ROWS && candidates.size < censusGoal && !signal?.aborted) {
      const batch = await selectRows(
        MOTUS_DATASETS.census,
        {
          $select: CENSUS_COLUMNS,
          $where: censusDateWhere,
          $order: 'add_date asc, dot_number asc',
          $limit: String(CENSUS_PAGE),
          $offset: String(offset),
        },
        signal,
      );

      if (!batch) {
        if (offset === 0 && candidates.size === 0) {
          return emptyResult(started, 'The FMCSA Company Census File did not respond. Try again in a moment.', ranges);
        }
        warnings.push('The census read stopped early, so this preview is partial.');
        break;
      }

      scanned += batch.length;
      for (const record of batch) {
        const dot = digits(record.dot_number);
        if (dot && !candidates.has(dot)) candidates.set(dot, { record });
      }

      offset += batch.length;
      if (batch.length < CENSUS_PAGE) break;
    }
  }

  if (candidates.size === 0) {
    return {
      rows: [],
      ok: true,
      warnings,
      candidates: censusCount,
      filingsInRange: filingCount,
      scanned,
      truncated: false,
      complete: true,
      unenrichedCount: 0,
      dateMode: mode,
      ranges,
      funnel: buildFunnel({
        dateMode: mode,
        censusCount,
        inspected: 0,
        drops: {},
        returned: 0,
        matched: 0,
        limit: target,
      }),
      rejected: {},
      rejectedTruncated: [],
      elapsedMs: Date.now() - started,
    };
  }

  /* Filings for the finalists, then choose the one that explains the row ---- */
  const { byDot, failedDots, failed, lastError } = await fetchFilings(
    [...candidates.keys()],
    signal,
    Date.now() + 48_000,
  );

  // Never allow a batch where every MOTUS carrier lookup failed to complete with 0 leads.
  if (failedDots.size >= candidates.size && candidates.size > 0) {
    return emptyResult(
      started,
      `MOTUS carrier-detail lookups failed for all ${candidates.size.toLocaleString('en-US')} candidate(s) (${
        lastError ?? 'HTTP 403 / upstream timeout'
      }). Automatic cooldown and pacing are active — wait a few seconds and retry.`,
      ranges,
      failedDots.size,
    );
  }

  if (failed || failedDots.size > 0) {
    warnings.push(
      `Batch incomplete: ${failedDots.size.toLocaleString('en-US')} carrier(s) could not be validated because MOTUS rate-limited or failed part of the lookup${
        lastError ? ` (${lastError})` : ''
      }. Unverified carriers are held in "Waiting for MOTUS enrichment" rather than being marked as uninsured.`,
    );
  }

  const rows: (LeadRow & { sortDate: string | null })[] = [];
  const drops: Partial<Record<DropReason, number>> = {};
  const rejected: Partial<Record<DropReason, LeadRow[]>> = {};
  const truncatedReasons = new Set<DropReason>();

  const drop = (reason: DropReason, lead: LeadRow) => {
    drops[reason] = (drops[reason] ?? 0) + 1;
    const bucket = rejected[reason] ?? (rejected[reason] = []);
    if (bucket.length < REJECTED_CAP_PER_REASON) bucket.push(lead);
    else truncatedReasons.add(reason);
  };

  for (const [dot, candidate] of candidates) {
    const filings = byDot.get(dot) ?? [];
    const selected = legacyWindow
      ? selectPolicy(filings, {
          from: legacyWindow.from,
          to: legacyWindow.to,
          todayCompact,
          allowCurrentFallback: mode === 'registration',
        })
      : selectPolicy(filings, {
          effective: mode === 'policy' ? ranges.effective : null,
          expiry: ranges.expiry,
          todayCompact,
          allowCurrentFallback: mode === 'registration' && !hasExpiry,
        });

    const lead = mapLeadRow(candidate.record, selected, today);

    if (!lead) {
      drops.unmapped = (drops.unmapped ?? 0) + 1;
      continue;
    }

    // Never misclassify an unenriched / 403-blocked carrier as "no_filings" or
    // allow it through with incomplete insurance verification.
    if (failedDots.has(dot) && filings.length === 0) {
      lead.notes.unshift(
        'Waiting for MOTUS enrichment — policy lookup failed or was rate-limited, so eligibility could not be validated.',
      );
      drop('lookup_failed', lead);
      continue;
    }

    if (filings.length === 0) {
      drop('no_filings', lead);
      continue;
    }
    if (!selected.filing || (mode === 'policy' && !selected.reason) || (hasExpiry && !selected.reason)) {
      drop('out_of_range', lead);
      continue;
    }

    if (legacyWindow) {
      if (mode === 'policy') {
        const shownInRange =
          withinWindow(lead.effectiveDate, legacyWindow.from, legacyWindow.to) ||
          withinWindow(lead.expiringDate, legacyWindow.from, legacyWindow.to);
        if (!shownInRange) {
          drop('out_of_range', lead);
          continue;
        }
      } else {
        const expiring = compact(lead.expiringDate);
        const compactTo = compact(legacyWindow.to);
        if (expiring && expiring < compactTo) {
          drop('expired_before_to', lead);
          continue;
        }
      }
    } else if (mode === 'policy') {
      // Belt and braces: every active date filter must be satisfied by the displayed policy.
      if (hasEffective && !withinDateBound(lead.effectiveDate, ranges.effective)) {
        drop('out_of_range', lead);
        continue;
      }
      if (hasExpiry && !withinDateBound(lead.expiringDate, ranges.expiry)) {
        drop('out_of_range', lead);
        continue;
      }
    } else {
      // Registration mode: census add_date matches `effective`, and when `expiry`
      // is also populated, the policy's expiring date must sit inside `expiry`.
      if (hasEffective && !withinDateBound(lead.addDate, ranges.effective)) {
        drop('out_of_range', lead);
        continue;
      }
      if (hasExpiry && !withinDateBound(lead.expiringDate, ranges.expiry)) {
        const expCompact = compact(lead.expiringDate);
        const expFromCompact = compact(ranges.expiry.from);
        if (expCompact.length === 8 && expFromCompact.length === 8 && expCompact < expFromCompact) {
          drop('expired_before_to', lead);
        } else {
          drop('out_of_range', lead);
        }
        continue;
      }
    }

    if (filters.insurance === 'yes' && !lead.hasActiveCoverage) {
      drop('lapsed_cover', lead);
      continue;
    }
    if (filters.insurance === 'no' && lead.hasActiveCoverage) {
      drop('has_cover', lead);
      continue;
    }

    rows.push({ ...lead, sortDate: sortKey(selected, lead.addDate) });
  }

  rows.sort(compareLeads);
  const truncated = rows.length > target;
  const limited = rows.slice(0, target);
  const complete = failedDots.size === 0 && !failed;

  if (limited.length === 0) {
    warnings.push(
      mode === 'policy'
        ? 'No carrier matched the filters within the selected Effective / Expiry date ranges. Widen the dates or pick another lead category.'
        : filters.insurance === 'no'
          ? 'Carriers matched the filters, but every one of them has live insurance on file. Set Insurance to “Any” to see them.'
          : 'Carriers matched the filters, but none had live insurance on file. Set Insurance to “Any” to see them.',
    );
  }

  return {
    rows: limited.map(({ sortDate: _sortDate, ...row }) => row),
    ok: true,
    warnings,
    candidates: censusCount,
    filingsInRange: filingCount,
    scanned,
    truncated,
    complete,
    unenrichedCount: failedDots.size,
    dateMode: mode,
    ranges,
    funnel: buildFunnel({
      dateMode: mode,
      censusCount,
      inspected: candidates.size,
      drops,
      returned: limited.length,
      matched: rows.length,
      limit: target,
    }),
    rejected,
    rejectedTruncated: [...truncatedReasons],
    elapsedMs: Date.now() - started,
  };
}

/* -------------------------------------------------------------------------- */
/* Demo mode                                                                  */
/* -------------------------------------------------------------------------- */

const MOCK_STATES = ['TX', 'OK', 'TN', 'OH', 'GA'];
const MOCK_CITIES = ['DALLAS', 'TULSA', 'MEMPHIS', 'COLUMBUS', 'ATLANTA'];
const MOCK_NAMES = ['REDMULE LOGISTICS LLC', 'IRONHORSE TRANSPORT', 'CEDAR RIDGE HAULERS', 'SUMMIT CARRIER GROUP', 'BLUE OAK TRANSPORT'];
const MOCK_OFFICERS = [
  { name: 'Kulwinder Singh', first: 'Kulwinder', last: 'Singh' },
  { name: 'Timothy W Reynolds', first: 'Timothy W', last: 'Reynolds' },
  { name: 'Maria De La Cruz', first: 'Maria', last: 'De La Cruz' },
  { name: 'Paul Pritchard Briggs JR', first: 'Paul Pritchard', last: 'Briggs JR' },
  { name: 'Andrew Qandah', first: 'Andrew', last: 'Qandah' },
];

const MOCK_INSURERS = [
  'Old Republic Insurance Company',
  'Great West Casualty Company',
  'Progressive Preferred Insurance Co.',
];

function resolveMockSpan(bound: DateBound, fallbackStartIso: string, fallbackDays = 180): { startMs: number; spanMs: number } {
  const dayMs = 86_400_000;
  if (bound.from && bound.to) {
    const s = Date.parse(`${bound.from}T00:00:00Z`);
    const e = Date.parse(`${bound.to}T00:00:00Z`);
    return { startMs: s, spanMs: Math.max(e - s, dayMs) };
  }
  if (bound.from) {
    const s = Date.parse(`${bound.from}T00:00:00Z`);
    return { startMs: s, spanMs: fallbackDays * dayMs };
  }
  if (bound.to) {
    const e = Date.parse(`${bound.to}T00:00:00Z`);
    return { startMs: e - fallbackDays * dayMs, spanMs: fallbackDays * dayMs };
  }
  const f = Date.parse(`${fallbackStartIso}T00:00:00Z`);
  return { startMs: f, spanMs: fallbackDays * dayMs };
}

function mockSearch(
  input: LeadSearchInput,
  ranges: LeadDateRanges,
  legacyWindow: { from: string; to: string } | null,
): LeadSearchResult {
  const { filters, limit } = input;
  const today = todayIso();
  const hasEffective = hasDateBound(ranges.effective);
  const hasExpiry = hasDateBound(ranges.expiry);
  const effSpan = resolveMockSpan(
    legacyWindow ? { from: legacyWindow.from, to: legacyWindow.to } : ranges.effective,
    '2025-11-27',
    180,
  );
  const expSpan = resolveMockSpan(ranges.expiry, today, 90);
  const wanted = Math.min(Math.max(limit, 1), 60);
  const mode = resolveDateMode(filters, ranges);
  const rows: LeadRow[] = [];

  for (let i = 0; i < wanted * 3 && rows.length < wanted; i += 1) {
    const seed = 1_000_003 + i * 7919;
    const hasPolicy = filters.insurance === 'yes' || filters.insurance === 'any' || hasExpiry;
    const effMs = effSpan.startMs + Math.round((effSpan.spanMs * (i + 1)) / (wanted + 1));
    const effIso = new Date(effMs).toISOString().slice(0, 10);
    const expMs = expSpan.startMs + Math.round((expSpan.spanMs * (i + 1)) / (wanted + 1));
    const expIso = hasExpiry
      ? new Date(expMs).toISOString().slice(0, 10)
      : hasPolicy && i % 2 === 0
        ? new Date(effMs + 86_400_000 * 180).toISOString().slice(0, 10)
        : null;

    const addDate = hasEffective ? effIso : new Date(effMs - 86_400_000 * 365).toISOString().slice(0, 10);
    const effective = hasEffective ? effIso : new Date(expMs - 86_400_000 * 365).toISOString().slice(0, 10);
    const state = filters.states[0] ?? MOCK_STATES[i % MOCK_STATES.length];

    if (mode === 'policy' && !hasPolicy) continue;

    const matchReason: LeadRow['matchReason'] =
      hasEffective && hasExpiry
        ? 'both'
        : hasExpiry
          ? 'cancellation'
          : hasPolicy
            ? 'effective'
            : null;
    const matchDateKind: LeadRow['matchDateKind'] =
      matchReason === 'both'
        ? 'both'
        : matchReason === 'cancellation'
          ? 'expiring'
          : matchReason === 'effective'
            ? 'effective'
            : null;
    const matchedDate =
      matchReason === 'cancellation' ? expIso : matchReason ? effective : null;

    rows.push({
      dot: String(3_900_000 + (seed % 99_999)),
      docket: `MC${(seed % 900_000) + 100_000}`,
      legalName: MOCK_NAMES[i % MOCK_NAMES.length],
      ...(() => {
        const officer = MOCK_OFFICERS[i % MOCK_OFFICERS.length];
        return { officerName: officer.name, firstName: officer.first, lastName: officer.last };
      })(),
      dbaName: i % 4 === 0 ? null : `${MOCK_NAMES[i % MOCK_NAMES.length].split(' ')[0]} EXPRESS`,
      state,
      city: MOCK_CITIES[i % MOCK_CITIES.length],
      physicalStreet: `${100 + (seed % 8900)} WAREHOUSE ROW`,
      physicalZip: `7${String(seed % 90_000).padStart(5, '0')}`,
      mailingStreet: `${100 + (seed % 8900)} WAREHOUSE ROW`,
      mailingCity: MOCK_CITIES[i % MOCK_CITIES.length],
      mailingState: state,
      mailingZip: `7${String(seed % 90_000).padStart(5, '0')}`,
      phone: `2${String(10_000_000 + (seed % 89_999_999)).slice(0, 9)}`,
      email: i % 5 === 0 ? null : `dispatch${i + 1}@demo-carrier.com`,
      operation: i % 3 === 0 ? 'Intrastate' : 'Interstate',
      operationCode: i % 3 === 0 ? 'C' : 'A',
      authorityStatus: 'A',
      authorityLabel: 'Active',
      classDef: 'AUTHORIZED FOR HIRE',
      cargo: [['general'], ['general'], ['produce'], ['vehicles']][i % 4],
      cargoOther: null,
      equipment: `${1 + (seed % 6)} tractors · ${1 + (seed % 4)} trailers`,
      powerUnits: 1 + (seed % 9),
      addDate,
      mcs150Date: null,
      insurer: hasPolicy ? MOCK_INSURERS[i % MOCK_INSURERS.length] : null,
      policyNumber: hasPolicy ? `OLR${100_000 + (seed % 899_999)}` : null,
      effectiveDate: hasPolicy ? effective : null,
      expiringDate: expIso,
      policyType: hasPolicy ? 'BMC-91X' : null,
      coverage: hasPolicy ? 1_000_000 : null,
      hasActiveCoverage: filters.insurance === 'no' ? false : hasPolicy,
      matchReason,
      matchedDate,
      matchDateKind,
      sources: ['Demo mode'],
      notes: ['Demo record generated locally because MOCK_FMCSA=1.'],
    });
  }

  const inspected = rows.length + Math.round(rows.length * 0.42);
  const droppedDemo = inspected - rows.length;

  const weights: [DropReason, number][] =
    mode === 'policy'
      ? [['no_filings', 0.18], ['out_of_range', 0.15], ['lapsed_cover', 0.09]]
      : [['no_filings', 0.18], ['out_of_range', 0.15], ['has_cover', 0.09]];
  const totalWeight = weights.reduce((total, [, weight]) => total + weight, 0);

  const demoDrops: Partial<Record<DropReason, number>> = {};
  let allocated = 0;
  for (const [reason, weight] of weights) {
    const count = Math.floor((droppedDemo * weight) / totalWeight);
    if (count > 0) demoDrops[reason] = count;
    allocated += count;
  }
  if (droppedDemo - allocated > 0) {
    demoDrops[weights[0][0]] = (demoDrops[weights[0][0]] ?? 0) + (droppedDemo - allocated);
  }

  const demoRejected: Partial<Record<DropReason, LeadRow[]>> = {};
  for (const reason of Object.keys(demoDrops) as DropReason[]) {
    const count = demoDrops[reason] ?? 0;
    demoRejected[reason] = rows.slice(0, Math.min(count, 6)).map((row, index) => ({
      ...row,
      dot: String(Number(row.dot) + 500_000 + index),
      notes: [DEMO_DROP_NOTES[reason]],
      matchReason: null,
      matchedDate: null,
      matchDateKind: null,
      ...demoPolicyFor(reason),
    }));
  }

  return {
    rows,
    ok: true,
    warnings: ['Demo mode is on: these leads are generated locally, not read from FMCSA.'],
    candidates: hasEffective || legacyWindow ? inspected : null,
    filingsInRange: rows.filter((row) => row.policyNumber).length,
    scanned: rows.length,
    truncated: false,
    complete: true,
    unenrichedCount: 0,
    dateMode: mode,
    ranges,
    funnel: buildFunnel({
      dateMode: mode,
      censusCount: hasEffective || legacyWindow ? inspected : null,
      inspected,
      drops: demoDrops,
      returned: rows.length,
      matched: rows.length,
      limit: Math.min(Math.max(limit, 1), 60),
    }),
    rejected: demoRejected,
    rejectedTruncated: [],
    elapsedMs: 25,
  };
}

/** Policy columns consistent with why a demo carrier was dropped. */
function demoPolicyFor(reason: DropReason): Partial<LeadRow> {
  switch (reason) {
    case 'lookup_failed':
    case 'no_filings':
      return {
        insurer: null,
        policyNumber: null,
        effectiveDate: null,
        expiringDate: null,
        policyType: null,
        coverage: null,
        hasActiveCoverage: false,
      };
    case 'lapsed_cover':
      return { hasActiveCoverage: false };
    case 'has_cover':
      return { hasActiveCoverage: true, expiringDate: null };
    default:
      return {};
  }
}

const DEMO_DROP_NOTES: Record<DropReason, string> = {
  lookup_failed: 'Demo record: stands in for a carrier waiting on MOTUS enrichment.',
  no_filings: 'Demo record: stands in for a carrier with no insurance filing on FMCSA.',
  out_of_range: 'Demo record: stands in for a carrier whose policy dates miss the range.',
  lapsed_cover: 'Demo record: stands in for a carrier whose cover has lapsed.',
  expired_before_to: 'Demo record: stands in for a carrier whose cover ended before the end date.',
  has_cover: 'Demo record: stands in for a carrier that already has live cover.',
  unmapped: 'Demo record: stands in for a carrier that could not be mapped.',
};

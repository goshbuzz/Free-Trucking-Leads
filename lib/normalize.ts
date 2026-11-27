/**
 * Pure helpers: DOT parsing, date handling in Eastern Time, phone/email
 * normalisation, insurance classification and policy selection.
 *
 * Everything here is deterministic and unit-tested, because a wrong date or a
 * wrong policy number in a factoring workflow costs real money.
 */

import type { InsuranceKind, InsurancePolicy } from './types';

/* -------------------------------------------------------------------------- */
/* USDOT numbers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pull a USDOT number out of whatever a spreadsheet cell actually contains.
 *
 * Handles "1234567", "USDOT 1234567", "DOT#1234567", "us dot: 1234567",
 * numbers with stray whitespace, and Excel's habit of exporting "1234567.0".
 * Returns null when the cell cannot be read as a DOT number.
 */
export function parseDot(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text) return null;

  // Drop a trailing Excel decimal part: 1234567.0 / 1234567.00
  text = text.replace(/^(\d{1,8})\.0+$/, '$1');

  // Prefer an explicit "US DOT" style token if one is present.
  const labelled = text.match(/\b(?:US\s*-?\s*DOT|DOT|USDOT)\s*(?:NUM(?:BER)?|NO\.?|#)?\s*[:#\-]?\s*(\d{1,8})\b/i);
  if (labelled) return normaliseDigits(labelled[1]);

  // Otherwise accept the cell when it is only a number (plus punctuation).
  // Leading zeros are dropped first: spreadsheets happily export 001234567.
  const stripped = text.replace(/[,\s'’]/g, '');
  if (/^\d+$/.test(stripped) && stripped.replace(/^0+/, '').length <= 8) {
    return normaliseDigits(stripped);
  }

  // "MC123456" style cells: a docket, not a DOT. Explicitly rejected so the row
  // is reported as invalid instead of silently querying the wrong carrier.
  if (/^(?:MC|FF|MX)\s*-?\s*\d+$/i.test(stripped)) return null;

  return null;
}

function normaliseDigits(digits: string): string | null {
  const trimmed = digits.replace(/^0+(?=\d)/, '');
  if (!/^\d{1,8}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(value);
}

/** True when a cell looks like an MC/MX docket rather than a USDOT number. */
export function looksLikeDocket(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  return /^(?:MC|FF|MX)\s*-?\s*\d+$/i.test(String(raw).trim());
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

const EASTERN = 'America/New_York';

/**
 * Format an ISO date + optional time as an Eastern-Time timestamp.
 * FMCSA's "Created" column is specified as EDT (UTC-04:00) in the UI, so we
 * always render America/New_York with an explicit offset.
 */
export function formatEastern(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', 'UTC').replace('UTC', 'UTC') || 'UTC-05:00';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${offset}`;
}

/**
 * FMCSA dates come as yyyymmdd (census, Motus) or MM/DD/YYYY (QCMobile).
 * Return ISO yyyy-mm-dd, or null. Values like 00000000 are treated as absent.
 */
export function parseFmcsaDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text || text === '0') return null;

  let y: number, m: number, d: number;

  const compact = text.replace(/[^\d]/g, '');
  if (/^\d{8}$/.test(compact)) {
    y = Number(compact.slice(0, 4));
    m = Number(compact.slice(4, 6));
    d = Number(compact.slice(6, 8));
  } else if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    // Already ISO (possibly with a time component).
    y = Number(text.slice(0, 4));
    m = Number(text.slice(5, 7));
    d = Number(text.slice(8, 10));
  } else {
    return null;
  }

  if (!y || !m || !d) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;

  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime())) return null;
  // Reject impossible calendar days such as 2026-02-30.
  if (check.getUTCDate() !== d || check.getUTCMonth() + 1 !== m) return null;
  return iso;
}

/** Today in ISO form, used to decide whether a cancellation date is in the past. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* USDOT status                                                               */
/* -------------------------------------------------------------------------- */

/**
 * FMCSA publishes operating status three different ways depending on the
 * endpoint: `allowedToOperate` (Y/N), a census `status_code` (A/I/O) and free
 * text. Normalise to one of three words so the column is sortable and readable.
 */
export function usdotStatusLabel(allowedToOperate?: string | null, statusCode?: string | null): string | null {
  if (allowedToOperate) {
    const value = allowedToOperate.trim().toUpperCase();
    if (value === 'Y') return 'AUTHORIZED';
    if (value === 'N') return 'NOT AUTHORIZED';
  }

  if (statusCode) {
    const value = statusCode.trim().toUpperCase();
    if (value === 'A' || value === 'ACTIVE') return 'ACTIVE';
    if (value === 'I' || value === 'INACTIVE') return 'INACTIVE';
    if (value === 'O' || value === 'OUT OF SERVICE') return 'OUT OF SERVICE';
    if (value.length > 1) return value;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Phone                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * FMCSA stores phone numbers as bare 10-digit strings (sometimes with
 * punctuation or a leading 1). Format them for readability while keeping an
 * E.164 version for dialers and CRM imports.
 */
export function normalisePhone(raw: unknown): { display: string | null; e164: string | null } {
  if (raw === null || raw === undefined) return { display: null, e164: null };
  const digits = String(raw).replace(/\D/g, '');
  if (!digits || /^0+$/.test(digits)) return { display: null, e164: null };

  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return { display: String(raw).trim() || null, e164: null };
  if (ten.startsWith('0') || ten.startsWith('1')) return { display: ten, e164: null };

  const area = ten.slice(0, 3);
  const prefix = ten.slice(3, 6);
  const line = ten.slice(6);
  return { display: `(${area}) ${prefix}-${line}`, e164: `+1${ten}` };
}

/* -------------------------------------------------------------------------- */
/* Email                                                                      */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export interface EmailResult {
  email: string | null;
  /** FMCSA held something, but it is not a usable address (e.g. a bare domain). */
  needsCorrection: boolean;
  note?: string;
}

/**
 * FMCSA's census email field is free text typed by the carrier. Real values we
 * have seen include "EARTHNWOOD.COM" and "none". Never invent the missing part
 * of an address: flag it instead so the row is visibly incomplete.
 */
export function normaliseEmail(raw: unknown): EmailResult {
  if (raw === null || raw === undefined) return { email: null, needsCorrection: false };
  const text = String(raw).trim();
  if (!text || /^(?:none|n\/?a|no\s*email|null|-+)$/i.test(text)) {
    return { email: null, needsCorrection: false };
  }

  const match = text.match(EMAIL_RE);
  if (match) return { email: match[0].toLowerCase(), needsCorrection: false };

  if (/^(?:https?:\/\/|www\.)?[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i.test(text)) {
    return {
      email: null,
      needsCorrection: true,
      note: `FMCSA email field contains "${text}", which is a domain rather than an address — left blank for review.`,
    };
  }

  return {
    email: null,
    needsCorrection: true,
    note: `FMCSA email field contains "${text}", which is not a valid address — left blank for review.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * FMCSA officer names are upper case and sometimes duplicated across officer
 * 1 / officer 2 fields. Title-case them for a usable contact name.
 */
export function normaliseName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (/^(?:none|n\/?a|null|-+)$/i.test(text)) return null;

  return text
    .toLowerCase()
    .replace(/\b([a-z])([a-z'’\-]*)/g, (_m, first: string, rest: string) => first.toUpperCase() + rest)
    .replace(/\b(Mc)([a-z])/g, (_m, mc: string, next: string) => `${mc}${next.toUpperCase()}`)
    .replace(/\b(?:Ii|Iii|Iv)\b/g, (m) => m.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/* Insurance                                                                  */
/* -------------------------------------------------------------------------- */

const KIND_LABELS: Record<InsuranceKind, string> = {
  bipd: 'BIPD',
  cargo: 'Cargo',
  surety: 'Surety bond',
  trust: 'Trust fund',
  other: 'Other',
};

export function classifyInsurance(formCode?: string | null, typeCode?: string | null): InsuranceKind {
  const type = (typeCode ?? '').trim();
  if (type === '1') return 'bipd';
  if (type === '2') return 'cargo';
  if (type === '3') return 'surety';
  if (type === '4') return 'trust';

  const form = (formCode ?? '').toUpperCase().replace(/\s+/g, '');
  if (form.startsWith('BMC91')) return 'bipd';
  if (form === 'BMC34' || form === 'BMC83') return 'cargo';
  if (form === 'BMC84') return 'surety';
  if (form === 'BMC85') return 'trust';
  return 'other';
}

export function kindLabel(kind: InsuranceKind): string {
  return KIND_LABELS[kind];
}

const KIND_RANK: Record<InsuranceKind, number> = {
  bipd: 0, // the liability policy factoring and insurance teams ask about
  cargo: 1,
  surety: 2,
  trust: 3,
  other: 4,
};

function coverageValue(policy: InsurancePolicy): number {
  return typeof policy.coverage === 'number' && Number.isFinite(policy.coverage) ? policy.coverage : -1;
}

function dateValue(value: string | null | undefined): number {
  if (!value) return -1;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(t) ? -1 : t;
}

/**
 * Order policies so the most useful one lands first, then collapse duplicates.
 *
 * Rank order: active before inactive, BIPD before other coverages, largest
 * coverage first, most recent effective date first. A carrier's "current
 * policy" is therefore simply `policies[0]`.
 */
export function rankPolicies(policies: InsurancePolicy[], today = todayIso()): InsurancePolicy[] {
  const seen = new Set<string>();
  const deduped: InsurancePolicy[] = [];

  for (const policy of policies) {
    const key = [policy.policyNumber ?? '', policy.effectiveDate ?? '', policy.formCode ?? ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(policy);
  }

  return deduped.sort((a, b) => {
    const activeA = isActivePolicy(a, today) ? 1 : 0;
    const activeB = isActivePolicy(b, today) ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;

    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];

    const covA = coverageValue(a);
    const covB = coverageValue(b);
    if (covA !== covB) return covB - covA;

    const effA = dateValue(a.effectiveDate);
    const effB = dateValue(b.effectiveDate);
    if (effA !== effB) return effB - effA;

    return dateValue(b.transactionDate) - dateValue(a.transactionDate);
  });
}

export function isActivePolicy(policy: InsurancePolicy, today = todayIso()): boolean {
  if (!policy.cancellationDate) return true;
  return policy.cancellationDate > today;
}

/** Whole-dollar coverage from FMCSA's thousand-dollar strings ("2000000.00"). */
export function parseCoverage(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

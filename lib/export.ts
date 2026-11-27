/**
 * Export shaping for the enriched CSV.
 *
 * The ten required columns come first, in the order requested, so the file
 * drops straight into an existing lead / factoring template. Supporting columns
 * follow after a blank separator column so they can be deleted in one drag.
 */

import type { CarrierEnrichment } from './types';

export interface ExportColumn<T = CarrierEnrichment> {
  key: string;
  header: string;
  /** Value for one row. Return '' for a blank cell. */
  value: (row: T) => string | number | null;
  /**
   * Optional comparable value used for sorting when the display value is not
   * the right sort key (dates rendered with a timezone suffix, rank-ordered
   * statuses, and so on).
   */
  sortValue?: (row: T) => string | number | null;
  group: 'required' | 'supporting';
}

/** Sort rank so statuses read worst-last in the table, not alphabetically. */
const STATUS_RANK: Record<CarrierEnrichment['status'], number> = {
  invalid: 0,
  not_found: 1,
  retry: 2,
  partial: 3,
  enriched: 4,
};

const STATUS_LABELS: Record<CarrierEnrichment['status'], string> = {
  enriched: 'Enriched',
  partial: 'Partial - missing FMCSA data',
  not_found: 'Not found at FMCSA',
  invalid: 'Invalid DOT number',
  retry: 'Needs retry',
};

export function statusLabel(status: CarrierEnrichment['status']): string {
  return STATUS_LABELS[status];
}

export const REQUIRED_COLUMNS: ExportColumn[] = [
  { key: 'dot', header: 'DOT Number', group: 'required', value: (r) => r.dot },
  { key: 'contact', header: 'Contact name', group: 'required', value: (r) => r.contactName ?? '' },
  { key: 'business', header: 'Business name', group: 'required', value: (r) => r.legalName ?? '' },
  { key: 'phone', header: 'Phone', group: 'required', value: (r) => r.phone ?? '' },
  { key: 'email', header: 'Email', group: 'required', value: (r) => r.email ?? '' },
  {
    key: 'created',
    header: 'Created (EDT)',
    group: 'required',
    value: (r) => r.createdEdt ?? '',
    // Sort on the raw date so the timezone suffix never affects ordering.
    sortValue: (r) => r.createdEdt ?? '',
  },
  { key: 'policy', header: 'Policy Number', group: 'required', value: (r) => r.policy?.policyNumber ?? '' },
  { key: 'effective', header: 'Effective Date', group: 'required', value: (r) => r.policy?.effectiveDate ?? '' },
  { key: 'expiration', header: 'Expiration Date', group: 'required', value: (r) => r.policy?.cancellationDate ?? '' },
  {
    key: 'status',
    header: 'Enrichment Status',
    group: 'required',
    value: (r) => statusLabel(r.status),
    sortValue: (r) => STATUS_RANK[r.status] ?? 99,
  },
];

export const SUPPORTING_COLUMNS: ExportColumn[] = [
  { key: 'dba', header: 'DBA name', group: 'supporting', value: (r) => r.dbaName ?? '' },
  { key: 'phone_e164', header: 'Phone (E.164)', group: 'supporting', value: (r) => r.phoneE164 ?? '' },
  { key: 'insurer', header: 'Insurance company', group: 'supporting', value: (r) => r.policy?.insurer ?? '' },
  { key: 'policy_type', header: 'Policy type', group: 'supporting', value: (r) => r.policy?.kindLabel ?? '' },
  {
    key: 'coverage',
    header: 'Coverage (USD)',
    group: 'supporting',
    value: (r) => (r.policy?.coverage ? r.policy.coverage : ''),
    sortValue: (r) => r.policy?.coverage ?? null,
  },
  {
    key: 'policy_count',
    header: 'Policies on file',
    group: 'supporting',
    value: (r) => r.policies.length,
    sortValue: (r) => r.policies.length,
  },
  { key: 'usdot_status', header: 'USDOT status', group: 'supporting', value: (r) => r.usdotStatus ?? '' },
  { key: 'mcs150', header: 'MCS-150 update', group: 'supporting', value: (r) => r.mcs150Date ?? '' },
  {
    key: 'address',
    header: 'Physical address',
    group: 'supporting',
    value: (r) => [r.street, r.city, r.state, r.zip].filter(Boolean).join(', '),
  },
  {
    key: 'power_units',
    header: 'Power units',
    group: 'supporting',
    value: (r) => (r.powerUnits === null || r.powerUnits === undefined ? '' : r.powerUnits),
    sortValue: (r) => r.powerUnits ?? null,
  },
  { key: 'sources', header: 'Data sources', group: 'supporting', value: (r) => r.sources.join(' | ') },
  { key: 'missing', header: 'Missing fields', group: 'supporting', value: (r) => r.missing.join('; ') },
  { key: 'notes', header: 'Notes', group: 'supporting', value: (r) => r.notes.join(' ') },
];

export const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...SUPPORTING_COLUMNS];

/** RFC 4180 escaping, plus Excel formula-injection protection. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (text === '') return '';

  // A leading =, +, - or @ is executed as a formula by Excel/Sheets.
  // Phone numbers and dates never start with these, so prefixing is safe.
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export interface BuildCsvOptions {
  includeSupporting?: boolean;
  /** Add a blank spacer column between required and supporting groups. */
  spacer?: boolean;
}

export function buildCsv(rows: readonly CarrierEnrichment[], options: BuildCsvOptions = {}): string {
  const { includeSupporting = true, spacer = true } = options;
  const columns = includeSupporting ? ALL_COLUMNS : REQUIRED_COLUMNS;

  const lines: string[] = [];
  const headerCells = columns.map((c) => csvCell(c.header));
  if (includeSupporting && spacer) {
    const splitAt = REQUIRED_COLUMNS.length;
    headerCells.splice(splitAt, 0, '');
  }
  lines.push(headerCells.join(','));

  for (const row of rows) {
    const cells = columns.map((c) => csvCell(c.value(row)));
    if (includeSupporting && spacer) cells.splice(REQUIRED_COLUMNS.length, 0, '');
    lines.push(cells.join(','));
  }

  // UTF-8 BOM so Excel opens accented names correctly, CRLF per RFC 4180.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Filename that sorts chronologically and says what is inside. */
export function exportFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}`;
  return `fmcsa-enriched-${stamp}.csv`;
}

/** Summary numbers for the stat cards. */
export interface Summary {
  uploaded: number;
  enriched: number;
  missingFields: number;
  needsAttention: number;
  totalMissingCells: number;
}

export function summarise(rows: readonly CarrierEnrichment[]): Summary {
  let enriched = 0;
  let needsAttention = 0;
  let totalMissingCells = 0;
  const rowsWithMissing = new Set<number>();

  rows.forEach((row, index) => {
    if (row.status === 'enriched') enriched += 1;
    if (row.status === 'retry' || row.status === 'invalid' || row.status === 'not_found' || row.needsCorrection) {
      needsAttention += 1;
    }
    totalMissingCells += row.missing.length;
    if (row.missing.length > 0) rowsWithMissing.add(index);
  });

  return {
    uploaded: rows.length,
    enriched,
    // "Missing fields" counts cells, matching how the reference dashboard totals it.
    missingFields: totalMissingCells,
    needsAttention,
    totalMissingCells,
  };
}

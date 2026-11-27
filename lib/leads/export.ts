/**
 * Export columns for a lead preview.
 *
 * These headers are the ones the desk asked for, in this order, so the download
 * drops into an existing dialer / CRM import without renaming anything:
 *
 *   DOT · MC · Business Name · State · Phone · Email · Street address (mailing)
 *   City · State (mailing) · Postal Code · Carrier 1 · Policy Number 1 ·
 *   Effective Date 1 · Expiring Date 1 · Active · Interstate/Intrastate ·
 *   Commodities · Truck Trailers
 *
 * Supporting columns after the blank separator carry the evidence: physical
 * address, coverage, MCS-150 date, sources and notes.
 */

import type { LeadRow } from '../types';
import { cargoLabel } from './cargo';
import { csvCell, type ExportColumn } from '../export';

export const LEAD_COLUMNS: ExportColumn<LeadRow>[] = [
  { key: 'dot', header: 'DOT', group: 'required', value: (row) => row.dot },
  { key: 'docket', header: 'MC', group: 'required', value: (row) => row.docket ?? '' },
  { key: 'first_name', header: 'First Name', group: 'required', value: (row) => row.firstName ?? '' },
  { key: 'last_name', header: 'Last Name', group: 'required', value: (row) => row.lastName ?? '' },
  { key: 'legal_name', header: 'Business Name', group: 'required', value: (row) => row.legalName ?? '' },
  {
    key: 'state',
    header: 'State',
    group: 'required',
    value: (row) => row.state ?? '',
  },
  { key: 'phone', header: 'Phone Number', group: 'required', value: (row) => row.phone ?? '' },
  { key: 'email', header: 'Email', group: 'required', value: (row) => row.email ?? '' },
  {
    key: 'street',
    header: 'Street address',
    group: 'required',
    value: (row) => row.mailingStreet ?? row.physicalStreet ?? '',
  },
  {
    key: 'city',
    header: 'City',
    group: 'required',
    value: (row) => row.mailingCity ?? row.city ?? '',
  },
  {
    key: 'postal',
    header: 'Postal Code',
    group: 'required',
    value: (row) => row.mailingZip ?? row.physicalZip ?? '',
  },
  { key: 'carrier1', header: 'Carrier 1', group: 'required', value: (row) => row.insurer ?? '' },
  { key: 'policy1', header: 'Policy Number 1', group: 'required', value: (row) => row.policyNumber ?? '' },
  { key: 'effective1', header: 'Effective Date 1', group: 'required', value: (row) => row.effectiveDate ?? '' },
  { key: 'expiring1', header: 'Expiring Date 1', group: 'required', value: (row) => row.expiringDate ?? '' },
  {
    key: 'active',
    header: 'Active',
    group: 'required',
    value: (row) => row.authorityLabel ?? '',
  },
  {
    key: 'operation',
    header: 'Interstate or Intrastate',
    group: 'required',
    value: (row) => row.operation ?? '',
  },
  {
    key: 'commodities',
    header: 'Commodities',
    group: 'required',
    value: (row) => row.cargo.map((id) => cargoLabel(id)).join('; '),
  },
  { key: 'truck_trailers', header: 'Truck Trailers', group: 'required', value: (row) => row.equipment ?? '' },
];

export const LEAD_SUPPORTING_COLUMNS: ExportColumn<LeadRow>[] = [
  { key: 'dba', header: 'DBA name', group: 'supporting', value: (row) => row.dbaName ?? '' },
  {
    key: 'physical_address',
    header: 'Physical address',
    group: 'supporting',
    value: (row) =>
      [row.physicalStreet, row.city, row.state, row.physicalZip].filter(Boolean).join(', '),
  },
  {
    key: 'mailing_state',
    header: 'Mailing state',
    group: 'supporting',
    value: (row) => row.mailingState ?? '',
  },
  {
    key: 'coverage',
    header: 'Coverage (USD)',
    group: 'supporting',
    value: (row) => (row.coverage ?? ''),
    sortValue: (row) => row.coverage ?? null,
  },
  { key: 'policy_type', header: 'Policy type', group: 'supporting', value: (row) => row.policyType ?? '' },
  {
    key: 'active_cover',
    header: 'Cover live today',
    group: 'supporting',
    value: (row) => (row.hasActiveCoverage ? 'Yes' : 'No'),
  },
  { key: 'classdef', header: 'Operating class', group: 'supporting', value: (row) => row.classDef ?? '' },
  {
    key: 'power_units',
    header: 'Power units',
    group: 'supporting',
    value: (row) => row.powerUnits ?? '',
    sortValue: (row) => row.powerUnits,
  },
  { key: 'add_date', header: 'Census added date', group: 'supporting', value: (row) => row.addDate ?? '' },
  { key: 'mcs150', header: 'MCS-150 update', group: 'supporting', value: (row) => row.mcs150Date ?? '' },
  { key: 'sources', header: 'Data sources', group: 'supporting', value: (row) => row.sources.join(' | ') },
  { key: 'notes', header: 'Notes', group: 'supporting', value: (row) => row.notes.join(' ') },
];

export const LEAD_ALL_COLUMNS = [...LEAD_COLUMNS, ...LEAD_SUPPORTING_COLUMNS];

/** RFC 4180 CSV with a BOM so Excel opens it correctly. */
export function buildLeadCsv(rows: readonly LeadRow[], options: { includeSupporting?: boolean } = {}): string {
  const { includeSupporting = true } = options;
  const columns: ExportColumn<LeadRow>[] = includeSupporting
    ? LEAD_ALL_COLUMNS
    : LEAD_COLUMNS;

  const header = columns.map((column) => csvCell(column.header));
  if (includeSupporting) header.splice(LEAD_COLUMNS.length, 0, '');
  const lines = [header.join(',')];

  for (const row of rows) {
    const cells = columns.map((column) => csvCell(column.value(row)));
    if (includeSupporting) cells.splice(LEAD_COLUMNS.length, 0, '');
    lines.push(cells.join(','));
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Filename for an export. A suffix names the funnel reason so a downloaded
 * rejected list cannot be mistaken for the lead list itself.
 */
export function leadFilename(now: Date = new Date(), suffix?: string): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}`;
  return `fmcsa-leads${suffix ? `-${suffix}` : ''}-${stamp}.csv`;
}

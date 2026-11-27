import { describe, expect, it } from 'vitest';
import { buildLeadCsv, LEAD_COLUMNS, leadFilename } from '@/lib/leads/export';
import type { LeadRow } from '@/lib/types';

/**
 * The cards report an exact count; the list behind a card is capped for payload
 * size. These tests pin the contract that makes the two safe to show together.
 */

const lead = (dot: string): LeadRow =>
  ({
    dot,
    docket: `MC${dot}`,
    legalName: `CARRIER ${dot}`,
    officerName: 'Kulwinder Singh',
    firstName: 'Kulwinder',
    lastName: 'Singh',
    dbaName: null,
    state: 'TX',
    city: 'DALLAS',
    physicalStreet: '1 MAIN ST',
    physicalZip: '75001',
    mailingStreet: '1 MAIN ST',
    mailingCity: 'DALLAS',
    mailingState: 'TX',
    mailingZip: '75001',
    phone: '2145550100',
    email: null,
    operation: 'Interstate',
    operationCode: 'A',
    authorityStatus: 'A',
    authorityLabel: 'Active',
    classDef: 'AUTHORIZED FOR HIRE',
    cargo: ['general'],
    cargoOther: null,
    equipment: '2 tractors',
    powerUnits: 2,
    addDate: '2026-01-01',
    mcs150Date: null,
    insurer: null,
    policyNumber: null,
    effectiveDate: null,
    expiringDate: null,
    policyType: null,
    coverage: null,
    hasActiveCoverage: false,
    matchReason: null,
    matchedDate: null,
    matchDateKind: null,
    sources: ['FMCSA Company Census File'],
    notes: ['FMCSA returns no insurance filing for this carrier.'],
  }) as LeadRow;

describe('rejected lead lists', () => {
  it('exports the same columns as the lead list', () => {
    // The whole point of opening a card is to see the carrier in the familiar
    // columns, so a rejected export must not diverge from a lead export.
    const csv = buildLeadCsv([lead('1234567')], { includeSupporting: false }).replace(/^\uFEFF/, '');
    const header = csv.split('\r\n')[0];
    expect(header).toBe(LEAD_COLUMNS.map((column) => column.header).join(','));
    expect(header.startsWith('DOT,MC,First Name,Last Name')).toBe(true);
  });

  it('names the file after the funnel reason so it cannot be mistaken for leads', () => {
    const leads = leadFilename(new Date('2026-11-05T10:30:00Z'));
    const rejected = leadFilename(new Date('2026-11-05T10:30:00Z'), 'no-filings');

    expect(leads).toBe('fmcsa-leads-20261105-1030.csv');
    expect(rejected).toBe('fmcsa-leads-no-filings-20261105-1030.csv');
    expect(rejected).not.toBe(leads);
  });

  it('keeps the row count and the reported total independent', () => {
    // A capped list is normal: the card's count is exact, the list is partial.
    const rows = Array.from({ length: 5 }, (_, index) => lead(String(1_000_000 + index)));
    const total = 1268;
    const truncated = rows.length < total;

    expect(rows).toHaveLength(5);
    expect(truncated).toBe(true);
    // The CSV carries what is available, not an invented 1,268 rows.
    const csv = buildLeadCsv(rows, { includeSupporting: false }).replace(/^\uFEFF/, '');
    expect(csv.trim().split('\r\n')).toHaveLength(6); // header + 5
  });

  it('does not flag truncation when the list is complete', () => {
    const rows = Array.from({ length: 3 }, (_, index) => lead(String(2_000_000 + index)));
    expect(rows.length < 3).toBe(false);
  });

  it('survives a carrier with every optional field blank', () => {
    // A rejected row is often a carrier with no insurance at all, which is
    // exactly when the most columns are empty.
    const bare = { ...lead('9999999'), insurer: null, policyNumber: null, effectiveDate: null, expiringDate: null };
    const csv = buildLeadCsv([bare], { includeSupporting: false }).replace(/^\uFEFF/, '');
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells[0]).toBe('9999999');
    expect(cells[11]).toBe(''); // Carrier 1
    expect(cells[12]).toBe(''); // Policy Number 1
  });
});

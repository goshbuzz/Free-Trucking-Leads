import { describe, expect, it } from 'vitest';
import {
  applyColumnFilters,
  columnValues,
  describeFilter,
  isFilterIncomplete,
  matchesFilter,
  type ColumnFilter,
} from '@/lib/leads/columnFilters';
import type { LeadRow } from '@/lib/types';

const row = (overrides: Partial<LeadRow> & { dot: string }): LeadRow =>
  ({
    docket: 'MC100001',
    legalName: 'REDMULE LOGISTICS LLC',
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
    insurer: 'Progressive',
    policyNumber: 'CA1',
    effectiveDate: '2026-01-01',
    expiringDate: null,
    policyType: 'BMC-91X',
    coverage: 750000,
    hasActiveCoverage: true,
    matchReason: 'effective',
    matchedDate: '2026-01-01',
    matchDateKind: 'effective',
    sources: ['FMCSA'],
    notes: [],
    ...overrides,
  }) as LeadRow;

const rows: LeadRow[] = [
  row({ dot: '1001', state: 'TX', insurer: 'Progressive', coverage: 750000, expiringDate: null, phone: '2145550100' }),
  row({ dot: '1002', state: 'OK', insurer: 'Great West', coverage: 1000000, expiringDate: '2026-06-01', phone: '' }),
  row({ dot: '1003', state: 'tx', insurer: 'progressive', coverage: 500000, expiringDate: '2026-03-01', phone: '9185550100' }),
  row({ dot: '1004', state: 'CA', insurer: null, coverage: null, expiringDate: null, phone: '' }),
];

describe('matchesFilter', () => {
  it('matches text case-insensitively, as a person expects', () => {
    const filter: ColumnFilter = { columnKey: 'state', op: 'equals', value: 'TX' };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1001', '1003']);
  });

  it('contains searches inside the cell', () => {
    const filter: ColumnFilter = { columnKey: 'insurer', op: 'contains', value: 'prog' };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1001', '1003']);
  });

  it('is any of behaves like spreadsheet checkboxes', () => {
    const filter: ColumnFilter = { columnKey: 'state', op: 'in', values: ['TX', 'OK'] };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1001', '1002', '1003']);
  });

  it('is none of excludes the ticked values', () => {
    const filter: ColumnFilter = { columnKey: 'state', op: 'notIn', values: ['TX'] };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1002', '1004']);
  });

  it('finds blanks and non-blanks', () => {
    expect(rows.filter((entry) => matchesFilter(entry, { columnKey: 'phone', op: 'empty' })).map((e) => e.dot)).toEqual([
      '1002',
      '1004',
    ]);
    expect(
      rows.filter((entry) => matchesFilter(entry, { columnKey: 'phone', op: 'notEmpty' })).map((e) => e.dot),
    ).toEqual(['1001', '1003']);
  });

  it('compares dates chronologically', () => {
    const filter: ColumnFilter = { columnKey: 'expiringDate', op: 'gte', value: '2026-04-01' };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1002']);
  });

  it('compares amounts numerically, not as text', () => {
    // "500000" > "750000" as a string would be wrong; numerically it is right.
    const filter: ColumnFilter = { columnKey: 'coverage', op: 'gte', value: '700000' };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1001', '1002']);
  });

  it('treats a blank-as-next-cell correctly in ranges', () => {
    const filter: ColumnFilter = { columnKey: 'expiringDate', op: 'between', value: '2026-01-01', value2: '2026-12-31' };
    expect(rows.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.dot)).toEqual(['1002', '1003']);
  });

  it('does not hide everything when the operand is empty', () => {
    // An unfinished rule must be inert, not a filter that matches nothing —
    // otherwise typing the first character of a search blanks the table.
    for (const op of ['contains', 'equals', 'notEquals'] as const) {
      const filter: ColumnFilter = { columnKey: 'state', op, value: '' };
      expect(rows.every((entry) => matchesFilter(entry, filter))).toBe(true);
    }
    expect(rows.every((entry) => matchesFilter(entry, { columnKey: 'state', op: 'in', values: [] }))).toBe(true);
  });
});

describe('applyColumnFilters', () => {
  it('requires every filter to pass', () => {
    const filters: ColumnFilter[] = [
      { columnKey: 'state', op: 'equals', value: 'TX' },
      { columnKey: 'coverage', op: 'gte', value: '600000' },
    ];
    expect(applyColumnFilters(rows, filters).map((entry) => entry.dot)).toEqual(['1001']);
  });

  it('returns a copy when there is nothing to filter', () => {
    const result = applyColumnFilters(rows, []);
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });
});

describe('columnValues', () => {
  it('lists distinct values, most frequent first', () => {
    const { values, blankCount } = columnValues(rows, 'state');
    expect(values[0]).toEqual({ value: 'TX', count: 2 });
    expect(blankCount).toBe(0);
    expect(values.map((entry) => entry.value)).toContain('OK');
  });

  it('counts blanks separately instead of listing them', () => {
    const { blankCount } = columnValues(rows, 'phone');
    expect(blankCount).toBe(2);
  });

  it('caps long lists and says so', () => {
    const many = Array.from({ length: 80 }, (_, index) => row({ dot: String(index), city: `CITY ${index}` }));
    const { values, truncated } = columnValues(many, 'city', 10);
    expect(values).toHaveLength(10);
    expect(truncated).toBe(true);
  });
});

describe('filter descriptions', () => {
  it('reads like a sentence for the chip row', () => {
    expect(describeFilter({ columnKey: 'state', op: 'equals', value: 'TX' }, 'State')).toBe('State is exactly “TX”');
    expect(describeFilter({ columnKey: 'phone', op: 'empty' }, 'Phone Number')).toBe('Phone Number is blank');
    expect(describeFilter({ columnKey: 'state', op: 'in', values: ['TX', 'OK'] }, 'State')).toBe('State is any of 2 values');
    expect(describeFilter({ columnKey: 'effective1', op: 'between', value: '2026-01-01', value2: '2026-06-30' }, 'Effective Date 1')).toBe(
      'Effective Date 1 is between 2026-01-01 and 2026-06-30',
    );
  });
});

describe('isFilterIncomplete', () => {
  it('flags rules that have no operand yet', () => {
    expect(isFilterIncomplete({ columnKey: 'state', op: 'contains', value: '' })).toBe(true);
    expect(isFilterIncomplete({ columnKey: 'state', op: 'in', values: [] })).toBe(true);
    expect(isFilterIncomplete({ columnKey: 'phone', op: 'empty' })).toBe(false);
    expect(isFilterIncomplete({ columnKey: 'state', op: 'equals', value: 'TX' })).toBe(false);
  });
});

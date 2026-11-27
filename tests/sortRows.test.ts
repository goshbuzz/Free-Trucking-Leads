import { describe, expect, it } from 'vitest';
import { ariaSortFor, nextSortState, sortRows, sortValueFor } from '@/lib/sortRows';
import type { CarrierEnrichment } from '@/lib/types';

const row = (over: Partial<CarrierEnrichment>): CarrierEnrichment => ({
  dot: '1000000',
  status: 'enriched',
  legalName: null,
  dbaName: null,
  contactName: null,
  phone: null,
  phoneE164: null,
  email: null,
  createdEdt: null,
  mcs150Date: null,
  street: null,
  city: null,
  state: null,
  zip: null,
  usdotStatus: null,
  powerUnits: null,
  drivers: null,
  policy: null,
  policies: [],
  sources: [],
  notes: [],
  missing: [],
  needsCorrection: false,
  lookup: { fmcsa: 'ok', census: 'ok', insurance: 'ok' },
  ...over,
});

const policy = (number: string, effective: string | null = null, cancellation: string | null = null) => ({
  formCode: 'BMC-91X',
  typeCode: '1',
  kind: 'bipd' as const,
  kindLabel: 'BIPD',
  insurer: 'Insurer',
  policyNumber: number,
  coverage: 1_000_000,
  effectiveDate: effective,
  cancellationDate: cancellation,
  transactionDate: null,
  active: true,
  source: 'motus-insur' as const,
});

describe('sortRows', () => {
  const rows = [
    row({ dot: '999', legalName: 'ZULU LLC' }),
    row({ dot: '1000', legalName: 'alpha transport' }),
    row({ dot: '20', legalName: null }),
    row({ dot: '300', legalName: 'Bravo Inc' }),
  ];

  it('returns upload order when unsorted', () => {
    expect(sortRows(rows, null).map((r) => r.dot)).toEqual(['999', '1000', '20', '300']);
  });

  it('sorts DOT numbers numerically, not as text', () => {
    const sorted = sortRows(rows, { key: 'dot', direction: 'asc' });
    expect(sorted.map((r) => r.dot)).toEqual(['20', '300', '999', '1000']);
  });

  it('sorts text case-insensitively', () => {
    const sorted = sortRows(rows, { key: 'business', direction: 'asc' });
    expect(sorted.map((r) => r.legalName)).toEqual(['alpha transport', 'Bravo Inc', 'ZULU LLC', null]);
  });

  it('keeps blanks last in both directions', () => {
    const asc = sortRows(rows, { key: 'business', direction: 'asc' });
    const desc = sortRows(rows, { key: 'business', direction: 'desc' });
    expect(asc[asc.length - 1].legalName).toBeNull();
    expect(desc[desc.length - 1].legalName).toBeNull();
    expect(desc[0].legalName).toBe('ZULU LLC');
  });

  it('does not mutate the input array', () => {
    const original = rows.map((r) => r.dot);
    sortRows(rows, { key: 'dot', direction: 'desc' });
    expect(rows.map((r) => r.dot)).toEqual(original);
  });

  it('is stable for equal values', () => {
    const equal = [row({ dot: '1', legalName: 'SAME' }), row({ dot: '2', legalName: 'SAME' })];
    expect(sortRows(equal, { key: 'business', direction: 'asc' }).map((r) => r.dot)).toEqual(['1', '2']);
  });

  it('sorts dates chronologically', () => {
    const dated = [
      row({ dot: '1', createdEdt: '2014-02-01 19:00:00 UTC-5' }),
      row({ dot: '2', createdEdt: '2005-05-19 20:00:00 UTC-4' }),
      row({ dot: '3', createdEdt: '2020-12-31 19:00:00 UTC-5' }),
    ];
    expect(sortRows(dated, { key: 'created', direction: 'asc' }).map((r) => r.dot)).toEqual(['2', '1', '3']);
  });

  it('orders statuses by severity, not alphabetically', () => {
    const statuses = [
      row({ dot: '1', status: 'enriched' }),
      row({ dot: '2', status: 'invalid' }),
      row({ dot: '3', status: 'partial' }),
      row({ dot: '4', status: 'not_found' }),
    ];
    expect(sortRows(statuses, { key: 'status', direction: 'asc' }).map((r) => r.status)).toEqual([
      'invalid',
      'not_found',
      'partial',
      'enriched',
    ]);
  });

  it('sorts policy columns and sinks carriers with no policy', () => {
    const withPolicies = [
      row({ dot: '1', policy: policy('BBB') }),
      row({ dot: '2', policy: null }),
      row({ dot: '3', policy: policy('AAA') }),
    ];
    expect(sortRows(withPolicies, { key: 'policy', direction: 'asc' }).map((r) => r.dot)).toEqual(['3', '1', '2']);
  });

  it('sorts supporting numeric columns', () => {
    const fleet = [
      row({ dot: '1', powerUnits: 40 }),
      row({ dot: '2', powerUnits: 2 }),
      row({ dot: '3', powerUnits: null }),
    ];
    expect(sortRows(fleet, { key: 'power_units', direction: 'desc' }).map((r) => r.dot)).toEqual(['1', '2', '3']);
  });

  it('treats an unknown column as unsortable rather than crashing', () => {
    expect(sortValueFor(rows[0], 'does_not_exist')).toBeNull();
    expect(sortRows(rows, { key: 'does_not_exist', direction: 'asc' })).toHaveLength(4);
  });
});

describe('nextSortState', () => {
  it('cycles ascending → descending → upload order', () => {
    const first = nextSortState(null, 'dot');
    expect(first).toEqual({ key: 'dot', direction: 'asc' });
    const second = nextSortState(first, 'dot');
    expect(second).toEqual({ key: 'dot', direction: 'desc' });
    expect(nextSortState(second, 'dot')).toBeNull();
  });

  it('restarts at ascending when switching columns', () => {
    expect(nextSortState({ key: 'dot', direction: 'desc' }, 'business')).toEqual({
      key: 'business',
      direction: 'asc',
    });
  });
});

describe('ariaSortFor', () => {
  it('reports the active column and direction', () => {
    const state = { key: 'dot', direction: 'desc' as const };
    expect(ariaSortFor(state, 'dot')).toBe('descending');
    expect(ariaSortFor(state, 'business')).toBe('none');
    expect(ariaSortFor(null, 'dot')).toBe('none');
  });
});

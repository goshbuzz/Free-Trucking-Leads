import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  buildCensusWhere,
  buildDateBoundClause,
  buildInsuranceRangesWhere,
  buildInsuranceWhere,
  censusDateClause,
  describeFilters,
  filtersAreCustom,
  normaliseFilters,
  parseKeywords,
  sanitiseKeyword,
} from '@/lib/leads/filters';
import {
  CARGO_TYPES,
  cargoExclusionClause,
  cargoFromRow,
  equipmentSummary,
  normaliseCargo,
  operationLabel,
  parseCargoList,
} from '@/lib/leads/cargo';
import { normaliseState, parseStateList, summariseStates, unrecognisedStates } from '@/lib/leads/states';
import { LEAD_CATEGORIES, applyCategory, findCategory } from '@/lib/leads/filters';
import { LEAD_COLUMNS, buildLeadCsv } from '@/lib/leads/export';
import type { LeadRow } from '@/lib/types';

describe('state filters', () => {
  it('accepts codes, lower case and full names', () => {
    expect(normaliseState('TX')).toBe('TX');
    expect(normaliseState('tx')).toBe('TX');
    expect(normaliseState('Texas')).toBe('TX');
    expect(normaliseState('new mexico')).toBe('NM');
    expect(normaliseState('D.C.')).toBe('DC');
  });

  it('rejects non-US-state text', () => {
    expect(normaliseState('PR')).toBeNull();
    expect(normaliseState('Ontario')).toBeNull();
    expect(normaliseState('')).toBeNull();
  });

  it('parses one state, several states and mixed separators', () => {
    expect(parseStateList('TX')).toEqual(['TX']);
    expect(parseStateList('tx, ok')).toEqual(['OK', 'TX']);
    expect(parseStateList('Texas; New Mexico | OH')).toEqual(['NM', 'OH', 'TX']);
    expect(parseStateList('')).toEqual([]);
  });

  it('reports only the tokens it could not use', () => {
    expect(unrecognisedStates('TX, ZZ, Oklahoma')).toEqual(['ZZ']);
  });

  it('summarises a selection', () => {
    expect(summariseStates([])).toBe('All states');
    expect(summariseStates(['TX'])).toBe('TX');
    expect(summariseStates(['TX', 'OK', 'TN'])).toBe('TX + 2 more');
  });
});

describe('cargo vocabulary', () => {
  it('maps every MCS-150 cargo type to a census column', () => {
    const withColumn = CARGO_TYPES.filter((type) => type.column);
    expect(withColumn.length).toBe(CARGO_TYPES.length - 1); // "Other" has none
    expect(withColumn.every((type) => (type.column ?? '').startsWith('crgo_'))).toBe(true);
  });

  it('resolves ids, labels and loose spellings', () => {
    expect(normaliseCargo('household')?.id).toBe('household');
    expect(normaliseCargo('Household Goods')?.id).toBe('household');
    expect(normaliseCargo('Liquids/Gases')?.id).toBe('liquids');
    expect(normaliseCargo('Oilfield Equipment')?.id).toBe('oilfield');
    expect(normaliseCargo('nonsense')).toBeNull();
  });

  it('keeps the canonical MCS-150 order and drops junk', () => {
    expect(parseCargoList(['waterwell', 'nonsense', 'household'])).toEqual(['household', 'waterwell']);
    expect(parseCargoList('passengers, usmail')).toEqual(['passengers', 'usmail']);
  });

  it('builds an exclusion clause that keeps nulls', () => {
    expect(cargoExclusionClause(['household', 'other'])).toBe(
      "(crgo_household is null or crgo_household != 'X')",
    );
    expect(cargoExclusionClause([])).toBeNull();
    expect(cargoExclusionClause(['other'])).toBeNull();
  });

  it('reads answered cargo boxes off a census row', () => {
    expect(cargoFromRow({ crgo_genfreight: 'X', crgo_household: null, crgo_liqgas: 'X' })).toEqual([
      'general',
      'liquids',
    ]);
  });
});

describe('operation and equipment', () => {
  it('translates the census operation code', () => {
    expect(operationLabel('A')).toBe('Interstate');
    expect(operationLabel('B')).toBe('Intrastate');
    expect(operationLabel('C')).toBe('Intrastate');
    expect(operationLabel(null)).toBeNull();
  });

  it('never invents equipment counts', () => {
    expect(equipmentSummary({ trucks: null, tractors: null, trailers: null })).toBeNull();
    expect(equipmentSummary({ trucks: 2, tractors: 0, trailers: 0 })).toBe('2 trucks');
    expect(equipmentSummary({ trucks: 1, tractors: 3, trailers: 2 })).toBe('3 tractors · 2 trailers · 1 truck');
    expect(equipmentSummary({ trucks: 0, tractors: 0, trailers: 0 })).toBe('No equipment reported');
  });
});

describe('keywords', () => {
  it('strips characters that would break a SoQL like clause', () => {
    expect(sanitiseKeyword("of household goods'")).toBe("of household goods'");
    expect(sanitiseKeyword('broker; drop table')).toBe('broker drop table');
    expect(sanitiseKeyword('a')).toBeNull();
  });

  it('deduplicates case-insensitively', () => {
    expect(parseKeywords('Broker, broker, freight forwarder')).toEqual(['broker', 'freight forwarder']);
  });
});

describe('normaliseFilters', () => {
  it('falls back to the defaults for unknown values', () => {
    const filters = normaliseFilters({ insurance: 'maybe', operation: 'boat', privatePolicy: 'sometimes' });
    expect(filters.insurance).toBe(DEFAULT_FILTERS.insurance);
    expect(filters.operation).toBe('any');
    expect(filters.privatePolicy).toBe(DEFAULT_FILTERS.privatePolicy);
  });

  it('normalises a full filter profile', () => {
    const filters = normaliseFilters({
      states: ['texas', 'OK'],
      excludedStates: 'CA, NY',
      operation: 'INTERSTATE',
      authorityStatus: 'PENDING',
      excludedCargo: ['Household Goods'],
      excludedKeywords: ['Broker'],
      truckTractorOnly: 'false',
    });
    expect(filters.states).toEqual(['OK', 'TX']);
    expect(filters.excludedStates).toEqual(['CA', 'NY']);
    expect(filters.excludedCargo).toEqual(['household']);
    expect(filters.excludedKeywords).toEqual(['broker']);
    expect(filters.truckTractorOnly).toBe(false);
  });
});

describe('SoQL builders', () => {
  it('searches a single included state', () => {
    const where = buildCensusWhere({ ...DEFAULT_FILTERS, states: ['TX'], excludedStates: [] }, { includeRejected: false });
    expect(where).toContain("phy_state in('TX')");
  });

  it('combines included and excluded states', () => {
    const where = buildCensusWhere(
      { ...DEFAULT_FILTERS, states: ['TX', 'OK'], excludedStates: ['CA'] },
      { includeRejected: false },
    );
    expect(where).toContain("phy_state in('TX','OK')");
    expect(where).toContain("phy_state not in('CA')");
  });

  it('drops rejected authorities unless they are requested', () => {
    const strict = buildCensusWhere(DEFAULT_FILTERS, { includeRejected: false });
    const loose = buildCensusWhere({ ...DEFAULT_FILTERS, authorityStatus: 'any' }, { includeRejected: true });
    expect(strict).toContain("status_code = 'A'");
    expect(loose).not.toContain("status_code = 'A'");
  });

  it('never leaves a completely empty filter set without a predicate', () => {
    const bare = buildCensusWhere(
      {
        ...DEFAULT_FILTERS,
        states: [],
        excludedStates: [],
        excludedCargo: [],
        excludedKeywords: [],
        forHireOnly: false,
        privatePolicy: 'include',
        authorityStatus: 'any',
        truckTractorOnly: false,
      },
      { includeRejected: true },
    );
    expect(bare).toBe('dot_number is not null');
  });

  it('escapes a quote inside a keyword', () => {
    const where = buildCensusWhere({ ...DEFAULT_FILTERS, excludedKeywords: ["driver's"] }, { includeRejected: false });
    expect(where).toContain("legal_name not like '%driver''s%'");
  });

  it('uses the census add date for the range', () => {
    expect(censusDateClause('2025-11-01', '2026-11-05')).toBe("add_date between '20251101' and '20261105'");
  });

  it('matches insurance on either the effective or the cancellation date', () => {
    expect(buildInsuranceWhere('2025-11-01', '2026-11-05')).toBe(
      "(effective_date between '20251101' and '20261105') or (cancl_effective_date between '20251101' and '20261105')",
    );
  });

  it('builds separate effective and expiry SoQL clauses', () => {
    expect(buildDateBoundClause('effective_date', { from: '2026-01-01', to: '2026-03-27' })).toBe(
      "effective_date between '20260101' and '20260327'",
    );
    expect(buildDateBoundClause('effective_date', { from: '2026-01-01', to: null })).toBe(
      "effective_date >= '20260101'",
    );
    expect(buildDateBoundClause('cancl_effective_date', { from: null, to: '2026-06-30' })).toBe(
      "cancl_effective_date <= '20260630'",
    );
    expect(buildDateBoundClause('effective_date', { from: null, to: null })).toBeNull();

    expect(
      buildInsuranceRangesWhere({
        effective: { from: '2025-01-01', to: '2025-03-31' },
        expiry: { from: '2026-01-01', to: '2026-03-31' },
      }),
    ).toBe("(effective_date between '20250101' and '20250331') and (cancl_effective_date between '20260101' and '20260331')");

    expect(
      buildInsuranceRangesWhere({
        effective: { from: '2026-01-01', to: '2026-03-27' },
        expiry: { from: null, to: null },
      }),
    ).toBe("effective_date between '20260101' and '20260327'");

    expect(
      buildInsuranceRangesWhere({
        effective: { from: null, to: null },
        expiry: { from: '2026-04-01', to: '2026-06-30' },
      }),
    ).toBe("cancl_effective_date between '20260401' and '20260630'");
  });
});

describe('filter summaries', () => {
  it('describes the default lead profile', () => {
    const summary = describeFilters(DEFAULT_FILTERS);
    expect(summary).toContain('For hire');
    expect(summary).toContain('Insurance: No');
    expect(summary).toContain('5 states excluded');
  });

  it('names a single state search', () => {
    expect(describeFilters({ ...DEFAULT_FILTERS, states: ['TX'] })).toContain('State: TX');
  });

  it('detects edited filters', () => {
    expect(filtersAreCustom(DEFAULT_FILTERS)).toBe(false);
    expect(filtersAreCustom({ ...DEFAULT_FILTERS, insurance: 'any' })).toBe(true);
  });
});

describe('lead categories', () => {
  it('has a category for every lead desk use case', () => {
    expect(LEAD_CATEGORIES.map((category) => category.id)).toEqual([
      'new_authority',
      'all_active',
      'insured',
      'private_fleet',
      'inactive',
    ]);
  });

  it('applies only the switches it names', () => {
    const start = { ...DEFAULT_FILTERS, excludedKeywords: ['my custom keyword'] };
    const insured = applyCategory(start, 'insured');
    expect(insured.insurance).toBe('yes');
    expect(insured.excludedKeywords).toEqual(['my custom keyword']);
    expect(insured.states).toEqual(start.states);
  });

  it('ignores an unknown category', () => {
    expect(applyCategory(DEFAULT_FILTERS, 'nope')).toEqual(DEFAULT_FILTERS);
    expect(findCategory('nope')).toBeNull();
  });
});

describe('lead CSV export', () => {
  const row: LeadRow = {
    dot: '1515240',
    docket: 'MC636400',
    legalName: 'ED\'S TRUCKING LLC',
    officerName: 'Ed Smith',
    firstName: 'Ed',
    lastName: 'Smith',
    dbaName: null,
    state: 'OR',
    city: 'KLAMATH FALLS',
    physicalStreet: '1301 ESPLANADE AVE',
    physicalZip: '97601',
    mailingStreet: '1301 ESPLANADE AVE',
    mailingCity: 'KLAMATH FALLS',
    mailingState: 'OR',
    mailingZip: '97601',
    phone: '5418878900',
    email: 'keith.lucht@edstaub.com',
    operation: 'Interstate',
    operationCode: 'A',
    authorityStatus: 'A',
    authorityLabel: 'Active',
    classDef: 'PRIVATE PROPERTY;AUTHORIZED FOR HIRE',
    cargo: ['general', 'liquids'],
    cargoOther: null,
    equipment: '181 tractors · 2 trailers',
    powerUnits: 181,
    addDate: '2006-06-14',
    mcs150Date: '2026-10-01',
    insurer: 'Oxford Insurance Company NC LLC',
    policyNumber: '611-26-NC',
    effectiveDate: '2026-02-01',
    expiringDate: null,
    policyType: 'BMC-91X',
    coverage: 3_000_000,
    hasActiveCoverage: true,
    matchReason: 'effective',
    matchedDate: '2026-02-01',
    matchDateKind: 'effective',
    sources: ['FMCSA Company Census File', 'Motus Insur'],
    notes: [],
  };

  it('exports the requested headers in the requested order', () => {
    const csv = buildLeadCsv([row], { includeSupporting: false });
    const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(header).toBe(
      [
        'DOT',
        'MC',
        'First Name',
        'Last Name',
        'Business Name',
        'State',
        'Phone Number',
        'Email',
        'Street address',
        'City',
        'Postal Code',
        'Carrier 1',
        'Policy Number 1',
        'Effective Date 1',
        'Expiring Date 1',
        'Active',
        'Interstate or Intrastate',
        'Commodities',
        'Truck Trailers',
      ].join(','),
    );
  });

  it('writes the mapped values', () => {
    const csv = buildLeadCsv([row], { includeSupporting: false });
    const cells = csv.replace(/^\uFEFF/, '').split('\r\n')[1].split(',');
    expect(cells[0]).toBe('1515240');
    expect(cells[1]).toBe('MC636400');
    expect(cells[2]).toBe('Ed');
    expect(cells[3]).toBe('Smith');
    expect(cells[4]).toBe("ED'S TRUCKING LLC");
    expect(cells[11]).toBe('Oxford Insurance Company NC LLC');
    expect(cells[12]).toBe('611-26-NC');
    expect(cells[14]).toBe(''); // no cancellation filed
    expect(cells[16]).toBe('Interstate');
    expect(cells[17]).toBe('General Freight; Liquids/Gases');
    expect(cells[18]).toBe('181 tractors · 2 trailers');
  });

  it('keeps supporting columns behind a blank separator', () => {
    const header = buildLeadCsv([row]).replace(/^\uFEFF/, '').split('\r\n')[0].split(',');
    expect(header[LEAD_COLUMNS.length]).toBe('');
    expect(header).toContain('Physical address');
  });
});

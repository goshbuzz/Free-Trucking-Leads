import { describe, expect, it } from 'vitest';
import { detectDelimiter, findDotColumn, hasDocketColumn, parseCsv, splitRows } from '@/lib/csv';
import { buildCsv, csvCell, REQUIRED_COLUMNS, statusLabel, summarise } from '@/lib/export';
import type { CarrierEnrichment } from '@/lib/types';

describe('parseCsv', () => {
  it('parses a simple sheet', () => {
    const parsed = parseCsv('DOT Number,Company\n1515240,Acme\n12873,Beta\n');
    expect(parsed.headers).toEqual(['DOT Number', 'Company']);
    expect(parsed.rows).toEqual([
      ['1515240', 'Acme'],
      ['12873', 'Beta'],
    ]);
  });

  it('handles BOM, CRLF and quoted commas', () => {
    const parsed = parseCsv('\uFEFFDOT,Notes\r\n1515240,"Reefer, dry van"\r\n12873,"Says ""hi"""\r\n');
    expect(parsed.headers).toEqual(['DOT', 'Notes']);
    expect(parsed.rows[0][1]).toBe('Reefer, dry van');
    expect(parsed.rows[1][1]).toBe('Says "hi"');
  });

  it('handles quoted newlines', () => {
    const parsed = parseCsv('DOT,Notes\n1515240,"line one\nline two"\n');
    expect(parsed.rows[0][1]).toBe('line one\nline two');
  });

  it('detects semicolon and tab exports', () => {
    expect(detectDelimiter('DOT;Company;Phone')).toBe(';');
    expect(detectDelimiter('DOT\tCompany\tPhone')).toBe('\t');
    const parsed = parseCsv('DOT;Company\n1515240;Acme\n');
    expect(parsed.rows[0]).toEqual(['1515240', 'Acme']);
  });

  it('treats a single headerless column as DOT numbers', () => {
    const parsed = parseCsv('1515240\n12873\n');
    expect(parsed.headers).toEqual(['DOT Number']);
    expect(parsed.rows).toEqual([['1515240'], ['12873']]);
  });

  it('pads ragged rows', () => {
    const parsed = parseCsv('DOT,Company,Phone\n1515240,Acme\n12873,Beta,5551234567\n');
    expect(parsed.rows[0]).toEqual(['1515240', 'Acme', '']);
  });
});

describe('findDotColumn', () => {
  it('prefers an exact DOT header', () => {
    const headers = ['Company', 'DOT Number', 'MC Number'];
    expect(findDotColumn(headers, [['Acme', '1515240', 'MC123']])).toBe(1);
  });

  it('ignores docket-like columns', () => {
    const headers = ['Company', 'MC Docket', 'USDOT'];
    expect(findDotColumn(headers, [['Acme', 'MC123', '1515240']])).toBe(2);
  });

  it('falls back to the only numeric column', () => {
    const headers = ['Id', 'Carrier'];
    expect(findDotColumn(headers, [['1515240', 'Acme'], ['12873', 'Beta']])).toBe(0);
  });

  it('returns null when only dockets exist', () => {
    const parsed = parseCsv('MC Number,Company\nMC123456,Acme\n');
    expect(findDotColumn(parsed.headers, parsed.rows)).toBeNull();
    expect(hasDocketColumn(parsed.headers)).toBe(true);
  });
});

describe('splitRows', () => {
  it('does not emit a phantom row for a trailing newline', () => {
    expect(splitRows('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('csvCell', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('@SUM(1)')).toBe("'@SUM(1)");
  });

  it('leaves numbers and negative-safe values alone', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('(214) 555-1234')).toBe('(214) 555-1234');
    expect(csvCell(null)).toBe('');
  });
});

const row = (over: Partial<CarrierEnrichment> = {}): CarrierEnrichment => ({
  dot: '1515240',
  status: 'enriched',
  legalName: 'ACME TRUCKING LLC',
  dbaName: null,
  contactName: 'Marcus Holloway',
  phone: '(214) 555-1234',
  phoneE164: '+12145551234',
  email: 'dispatch@acme.com',
  createdEdt: '2005-06-18 00:00:00 UTC-4',
  mcs150Date: '2024-02-03',
  street: '1 Main St',
  city: 'Dallas',
  state: 'TX',
  zip: '75212',
  usdotStatus: 'AUTHORIZED',
  powerUnits: 5,
  drivers: 6,
  policy: {
    formCode: 'BMC-91X',
    typeCode: '1',
    kind: 'bipd',
    kindLabel: 'BIPD',
    insurer: 'Old Republic',
    policyNumber: 'ABC1234567',
    coverage: 1_000_000,
    effectiveDate: '2024-01-01',
    cancellationDate: '2025-01-01',
    transactionDate: '2024-01-02',
    active: true,
    source: 'motus-insur',
  },
  policies: [],
  sources: ['FMCSA QCMobile'],
  notes: [],
  missing: [],
  needsCorrection: false,
  lookup: { fmcsa: 'ok', census: 'ok', insurance: 'ok' },
  ...over,
});

describe('buildCsv', () => {
  it('starts with the ten requested columns in order', () => {
    const csv = buildCsv([row()], { includeSupporting: false });
    const header = csv.replace('\uFEFF', '').split('\r\n')[0];
    expect(header.split(',')).toEqual([
      'DOT Number',
      'Contact name',
      'Business name',
      'Phone',
      'Email',
      'Created (EDT)',
      'Policy Number',
      'Effective Date',
      'Expiration Date',
      'Enrichment Status',
    ]);
    expect(REQUIRED_COLUMNS).toHaveLength(10);
  });

  it('writes values and blank cells', () => {
    const csv = buildCsv([row({ email: null, policy: null })], { includeSupporting: false });
    const data = csv.replace('\uFEFF', '').split('\r\n')[1];
    const cells = data.split(',');
    expect(cells[0]).toBe('1515240');
    expect(cells[4]).toBe('');
    expect(cells[9]).toBe('Enriched');
  });

  it('adds a blank spacer before supporting columns', () => {
    const csv = buildCsv([row()]);
    const header = csv.replace('\uFEFF', '').split('\r\n')[0].split(',');
    expect(header[10]).toBe('');
    expect(header[11]).toBe('DBA name');
  });
});

describe('summarise', () => {
  it('counts missing cells and attention rows', () => {
    const summary = summarise([
      row(),
      row({ dot: '1', status: 'partial', missing: ['Email', 'Policy Number'] }),
      row({ dot: '2', status: 'not_found', missing: ['Email'] }),
      row({ dot: '3', status: 'enriched', needsCorrection: true }),
    ]);
    expect(summary.uploaded).toBe(4);
    expect(summary.enriched).toBe(2);
    expect(summary.missingFields).toBe(3);
    expect(summary.needsAttention).toBe(2);
  });
});

describe('statusLabel', () => {
  it('is human readable', () => {
    expect(statusLabel('invalid')).toBe('Invalid DOT number');
    expect(statusLabel('retry')).toBe('Needs retry');
  });
});

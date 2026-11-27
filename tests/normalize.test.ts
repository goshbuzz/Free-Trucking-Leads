import { describe, expect, it } from 'vitest';
import {
  formatEastern,
  isActivePolicy,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  parseCoverage,
  parseDot,
  parseFmcsaDate,
  rankPolicies,
  usdotStatusLabel,
} from '@/lib/normalize';
import type { InsurancePolicy } from '@/lib/types';

describe('parseDot', () => {
  it('accepts plain digits', () => {
    expect(parseDot('1515240')).toBe('1515240');
    expect(parseDot(' 12873 ')).toBe('12873');
  });

  it('accepts labelled USDOT cells', () => {
    expect(parseDot('USDOT 1234567')).toBe('1234567');
    expect(parseDot('DOT#1234567')).toBe('1234567');
    expect(parseDot('us dot: 98765')).toBe('98765');
    expect(parseDot('USDOT No. 45678')).toBe('45678');
  });

  it('strips Excel decimal noise and padding', () => {
    expect(parseDot('1234567.0')).toBe('1234567');
    expect(parseDot('001234567')).toBe('1234567');
    expect(parseDot('1,234,567')).toBe('1234567');
  });

  it('rejects docket numbers and junk', () => {
    expect(parseDot('MC123456')).toBeNull();
    expect(parseDot('MC-123456')).toBeNull();
    expect(parseDot('')).toBeNull();
    expect(parseDot(null)).toBeNull();
    expect(parseDot('0')).toBeNull();
    expect(parseDot('123456789')).toBeNull();
    expect(parseDot('carrier')).toBeNull();
  });
});

describe('parseFmcsaDate', () => {
  it('reads the census yyyymmdd format', () => {
    expect(parseFmcsaDate('19870618')).toBe('1987-06-18');
  });

  it('reads ISO and ignores times', () => {
    expect(parseFmcsaDate('2025-02-01')).toBe('2025-02-01');
    expect(parseFmcsaDate('2025-02-01T00:00:00.000')).toBe('2025-02-01');
  });

  it('rejects impossible and empty values', () => {
    expect(parseFmcsaDate('20260230')).toBeNull();
    expect(parseFmcsaDate('00000000')).toBeNull();
    expect(parseFmcsaDate('')).toBeNull();
    expect(parseFmcsaDate(null)).toBeNull();
    expect(parseFmcsaDate('18990101')).toBeNull();
  });
});

describe('formatEastern', () => {
  it('renders Eastern time with an explicit offset', () => {
    expect(formatEastern('2024-07-01')).toBe('2024-06-30 20:00:00 UTC-4');
    expect(formatEastern('2024-01-15')).toBe('2024-01-14 19:00:00 UTC-5');
  });

  it('handles missing dates', () => {
    expect(formatEastern(null)).toBeNull();
    expect(formatEastern('')).toBeNull();
    expect(formatEastern('not-a-date')).toBeNull();
  });
});

describe('normalisePhone', () => {
  it('formats 10-digit numbers and builds E.164', () => {
    expect(normalisePhone('2145551234')).toEqual({ display: '(214) 555-1234', e164: '+12145551234' });
    expect(normalisePhone('1-214-555-1234')).toEqual({ display: '(214) 555-1234', e164: '+12145551234' });
  });

  it('keeps unusable numbers visible instead of guessing', () => {
    expect(normalisePhone('5551234')).toEqual({ display: '5551234', e164: null });
    expect(normalisePhone('0000000000')).toEqual({ display: null, e164: null });
    expect(normalisePhone(null)).toEqual({ display: null, e164: null });
  });
});

describe('normaliseEmail', () => {
  it('keeps valid addresses and lowercases them', () => {
    expect(normaliseEmail('Dispatch@AcmeTrucking.com')).toEqual({ email: 'dispatch@acmetrucking.com', needsCorrection: false });
  });

  it('flags a bare domain rather than inventing a mailbox', () => {
    const result = normaliseEmail('EARTHNWOOD.COM');
    expect(result.email).toBeNull();
    expect(result.needsCorrection).toBe(true);
    expect(result.note).toContain('domain rather than an address');
  });

  it('treats blanks and "none" as empty without a warning', () => {
    expect(normaliseEmail('')).toEqual({ email: null, needsCorrection: false });
    expect(normaliseEmail('none')).toEqual({ email: null, needsCorrection: false });
    expect(normaliseEmail(null)).toEqual({ email: null, needsCorrection: false });
  });
});

describe('normaliseName', () => {
  it('title-cases census officer names', () => {
    expect(normaliseName('ADAM WITTENSOLDNER')).toBe('Adam Wittensoldner');
    expect(normaliseName('SEAN MCDONALD')).toBe('Sean McDonald');
    expect(normaliseName('JOHN SMITH II')).toBe('John Smith II');
  });

  it('returns null for junk', () => {
    expect(normaliseName('')).toBeNull();
    expect(normaliseName('N/A')).toBeNull();
  });
});

describe('insurance ranking', () => {
  const make = (over: Partial<InsurancePolicy>): InsurancePolicy => ({
    formCode: 'BMC-91X',
    typeCode: '1',
    kind: 'bipd',
    kindLabel: 'BIPD',
    insurer: 'Insurer',
    policyNumber: 'P1',
    coverage: 1_000_000,
    effectiveDate: '2024-01-01',
    cancellationDate: null,
    transactionDate: '2024-01-02',
    active: true,
    source: 'motus-insur',
    ...over,
  });

  it('prefers active BIPD over everything else', () => {
    const ranked = rankPolicies(
      [
        make({ kind: 'cargo', kindLabel: 'Cargo', policyNumber: 'CARGO1', coverage: 100_000 }),
        make({ policyNumber: 'BIPD1' }),
      ],
      '2026-01-01',
    );
    expect(ranked[0].policyNumber).toBe('BIPD1');
  });

  it('drops terminated policies below active ones', () => {
    const ranked = rankPolicies(
      [
        make({ policyNumber: 'OLD', cancellationDate: '2025-01-01' }),
        make({ policyNumber: 'NEW', effectiveDate: '2025-06-01' }),
      ],
      '2026-01-01',
    );
    expect(ranked.map((p) => p.policyNumber)).toEqual(['NEW', 'OLD']);
  });

  it('prefers larger coverage for the same kind', () => {
    const ranked = rankPolicies(
      [make({ policyNumber: 'SMALL', coverage: 750_000 }), make({ policyNumber: 'BIG', coverage: 2_000_000 })],
      '2026-01-01',
    );
    expect(ranked[0].policyNumber).toBe('BIG');
  });

  it('deduplicates the same filing seen in two datasets', () => {
    const ranked = rankPolicies(
      [make({ policyNumber: 'X' }), make({ policyNumber: 'X', source: 'motus-inshist', cancellationDate: '2024-12-31' })],
      '2026-01-01',
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].source).toBe('motus-insur');
  });

  it('decides activity from a filed cancellation date only', () => {
    expect(isActivePolicy(make({ cancellationDate: null }), '2026-01-01')).toBe(true);
    expect(isActivePolicy(make({ cancellationDate: '2026-06-01' }), '2026-01-01')).toBe(true);
    expect(isActivePolicy(make({ cancellationDate: '2025-06-01' }), '2026-01-01')).toBe(false);
  });
});

describe('parseCoverage', () => {
  it('reads dollar amounts as published', () => {
    expect(parseCoverage('2000000.00')).toBe(2_000_000);
    expect(parseCoverage('75000.00')).toBe(75_000);
    expect(parseCoverage('0.00')).toBeNull();
    expect(parseCoverage(null)).toBeNull();
  });
});

describe('usdotStatusLabel', () => {
  it('prefers the operating-authority flag', () => {
    expect(usdotStatusLabel('Y', null)).toBe('AUTHORIZED');
    expect(usdotStatusLabel('N', null)).toBe('NOT AUTHORIZED');
  });

  it('falls back to the census status code', () => {
    expect(usdotStatusLabel(null, 'A')).toBe('ACTIVE');
    expect(usdotStatusLabel(null, 'I')).toBe('INACTIVE');
    expect(usdotStatusLabel(null, 'O')).toBe('OUT OF SERVICE');
  });

  it('returns null rather than a single unexplained letter', () => {
    expect(usdotStatusLabel(null, null)).toBeNull();
    expect(usdotStatusLabel('', '')).toBeNull();
  });
});

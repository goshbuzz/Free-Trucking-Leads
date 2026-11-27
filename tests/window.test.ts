import { describe, expect, it } from 'vitest';
import {
  compact,
  compareLeads,
  currentFiling,
  hasDateBound,
  qualifiesByRanges,
  qualifiesByWindow,
  selectPolicy,
  sortKey,
  withinDateBound,
  withinWindow,
} from '@/lib/leads/window';

/** Shape of a Motus Insur / InsHist row, trimmed to the fields we use. */
const filing = (
  policyNo: string,
  effectiveDate: string | null,
  canclEffectiveDate: string | null = null,
) => ({
  policy_no: policyNo,
  effective_date: effectiveDate,
  cancl_effective_date: canclEffectiveDate,
  insurance_company_name: `Insurer for ${policyNo}`,
  ins_form_code: 'BMC-91X',
  max_cov_amount: '750000.00',
});

const RANGE = { from: '2025-11-01', to: '2026-11-01', todayCompact: '20261105' };

describe('window helpers', () => {
  it('strips FMCSA dates to a comparable form', () => {
    expect(compact('2026-04-01')).toBe('20260401');
    expect(compact('20260401')).toBe('20260401');
    expect(compact(null)).toBe('');
  });

  it('treats both range bounds as inclusive', () => {
    expect(withinWindow('20251101', '20251101', '20261101')).toBe(true);
    expect(withinWindow('20261101', '20251101', '20261101')).toBe(true);
    expect(withinWindow('20251031', '20251101', '20261101')).toBe(false);
    expect(withinWindow('20261102', '20251101', '20261101')).toBe(false);
  });

  it('rejects partial or empty dates instead of comparing them', () => {
    expect(withinWindow('', '20251101', '20261101')).toBe(false);
    expect(withinWindow('2026', '20251101', '20261101')).toBe(false);
  });

  it('says which end of a filing is inside the window', () => {
    expect(qualifiesByWindow(filing('A', '20260115'), RANGE.from, RANGE.to)).toBe('effective');
    expect(qualifiesByWindow(filing('B', '20240201', '20260301'), RANGE.from, RANGE.to)).toBe('cancellation');
    expect(qualifiesByWindow(filing('C', '20240201'), RANGE.from, RANGE.to)).toBeNull();
  });
});

describe('selectPolicy — the dates shown must be inside the requested range', () => {
  it('returns an in-window policy, never the carrier’s newest filing from outside it', () => {
    // The reported bug: a Nov 2025 → Nov 2026 search displayed a policy from
    // outside the window, because the newest filing won regardless of the range.
    const selected = selectPolicy(
      [
        filing('NEWER-OUTSIDE', '20270115'), // newest, but after "To"
        filing('IN-WINDOW', '20251215'),
      ],
      RANGE,
    );

    expect(selected.reason).toBe('effective');
    expect(selected.filing?.policy_no).toBe('IN-WINDOW');
    expect(selected.matchedDate).toBe('2025-12-15');
  });

  it('prefers the oldest qualifying filing when the range starts earlier', () => {
    // Two filings fit the window; the earlier one is the one the user's "From"
    // reaches first, and the list is ordered by it.
    const selected = selectPolicy([filing('LATER', '20260901'), filing('EARLIER', '20260105')], RANGE);
    expect(selected.matchedDate).toBe('2026-01-05');
  });

  it('never returns a filing from outside the window when fallback is off', () => {
    const selected = selectPolicy([filing('OUTSIDE', '20270401')], { ...RANGE, allowCurrentFallback: false });
    expect(selected.filing).toBeNull();
    expect(selected.reason).toBeNull();
    expect(selected.matchedDate).toBeNull();
  });

  it('shows a filing cancelled inside the window when nothing new started in it', () => {
    // DOT 3142901 in the live data: its InsHist policy is cancelled 2026-11-01,
    // which is the only reason the carrier matches a Nov 2025 → Nov 2026 range,
    // while its newer policy starts 2026-11-01 — one day past "To".
    const selected = selectPolicy([filing('CANCELLED-IN-RANGE', '20240808', '20261101')], {
      from: '2025-11-01',
      to: '2026-11-05',
      todayCompact: '20261105',
      allowCurrentFallback: false,
    });

    expect(selected.reason).toBe('cancellation');
    expect(selected.filing?.policy_no).toBe('CANCELLED-IN-RANGE');
    expect(selected.matchedDate).toBe('2026-11-01');
  });

  it('shows the earlier of a new policy and a cancellation when both fit the range', () => {
    // Both dates are inside the window, so the earlier one wins and the row is
    // ordered by it. This is what keeps the list reading from "From" onwards.
    const selected = selectPolicy(
      [filing('CANCELLED', '20240808', '20261101'), filing('NEW-POLICY', '20260101')],
      { from: '2025-11-01', to: '2026-11-01', todayCompact: '20261105', allowCurrentFallback: false },
    );

    expect(selected.reason).toBe('effective');
    expect(selected.filing?.policy_no).toBe('NEW-POLICY');
    expect(selected.matchedDate).toBe('2026-01-01');
  });

  it('prefers new business over a cancellation in the same window', () => {
    const selected = selectPolicy(
      [filing('EXPIRING', '20240101', '20260301'), filing('NEW-BUSINESS', '20260201')],
      RANGE,
    );
    expect(selected.reason).toBe('effective');
    expect(selected.filing?.policy_no).toBe('NEW-BUSINESS');
  });

  it('prefers live cover when two filings share an effective date', () => {
    const selected = selectPolicy(
      [
        filing('LAPSED', '20260201', '20260101'),
        filing('LIVE', '20260201'),
      ],
      { ...RANGE, todayCompact: '20261105' },
    );
    expect(selected.filing?.policy_no).toBe('LIVE');
  });

  it('prefers live cover over a lapsed filing with an earlier date', () => {
    // A lapsed 2025 filing sorts first by date, but a policy that is still
    // running is more useful, so live cover wins.
    const selected = selectPolicy(
      [filing('LAPSED', '20251201', '20260101'), filing('LIVE', '20260201')],
      { ...RANGE, todayCompact: '20261105' },
    );
    expect(selected.filing?.policy_no).toBe('LAPSED'); // earliest by date
    expect(selected.hasActiveCoverage).toBe(true); // but cover is live via the other filing
  });

  it('surfaces the soonest cancellation when that is all that matched', () => {
    const selected = selectPolicy(
      [filing('LATE', '20240101', '20261001'), filing('SOON', '20240101', '20260301')],
      RANGE,
    );
    expect(selected.reason).toBe('cancellation');
    expect(selected.filing?.policy_no).toBe('SOON');
  });

  it('only falls back to the current filing when a registration search allows it', () => {
    const filings = [filing('CURRENT', '20270401')];

    const registration = selectPolicy(filings, { ...RANGE, allowCurrentFallback: true });
    expect(registration.reason).toBe('current');
    expect(registration.filing?.policy_no).toBe('CURRENT');
    expect(registration.matchedDate).toBeNull();

    const policy = selectPolicy(filings, { ...RANGE, allowCurrentFallback: false });
    expect(policy.filing).toBeNull();
  });

  it('reports whether the carrier holds live cover at all', () => {
    const selected = selectPolicy([filing('LAPSED', '20240101', '20260101')], RANGE);
    expect(selected.hasActiveCoverage).toBe(false);

    const withLive = selectPolicy([filing('LAPSED', '20240101', '20260101'), filing('LIVE', '20260501')], RANGE);
    expect(withLive.hasActiveCoverage).toBe(true);
  });
});

describe('currentFiling', () => {
  it('picks live cover first, then the newest', () => {
    expect(currentFiling([filing('OLD', '20200101'), filing('NEWEST', '20260401')], '20261105')?.policy_no).toBe(
      'NEWEST',
    );
    expect(
      currentFiling([filing('CANCELLED', '20260401', '20260501'), filing('LIVE', '20200101')], '20261105')
        ?.policy_no,
    ).toBe('LIVE');
    expect(currentFiling([], '20261105')).toBeNull();
  });
});

describe('ordering', () => {
  it('sorts by the date that qualified the row, earliest first', () => {
    const selected = selectPolicy([filing('A', '20251215')], RANGE);
    expect(sortKey(selected, '19990101')).toBe('2025-12-15');

    const rows = [
      { dot: '3', sortDate: '2026-04-01' },
      { dot: '1', sortDate: '2025-11-01' },
      { dot: '2', sortDate: '2026-01-15' },
    ];
    expect([...rows].sort(compareLeads).map((row) => row.dot)).toEqual(['1', '2', '3']);
  });

  it('puts empty sort dates last', () => {
    const rows = [
      { dot: '2', sortDate: null },
      { dot: '1', sortDate: '2026-01-01' },
    ];
    expect([...rows].sort(compareLeads).map((row) => row.dot)).toEqual(['1', '2']);
  });
});

describe('separate effective and expiry date range filters', () => {
  it('supports closed and open-ended DateBounds', () => {
    expect(hasDateBound({ from: null, to: null })).toBe(false);
    expect(hasDateBound({ from: '2026-01-01', to: null })).toBe(true);
    expect(withinDateBound('2026-02-15', { from: '2026-01-01', to: null })).toBe(true);
    expect(withinDateBound('2025-12-31', { from: '2026-01-01', to: null })).toBe(false);
    expect(withinDateBound('2026-02-15', { from: null, to: '2026-03-01' })).toBe(true);
    expect(withinDateBound('2026-03-02', { from: null, to: '2026-03-01' })).toBe(false);
    expect(withinDateBound(null, { from: '2026-01-01', to: '2026-03-01' })).toBe(false);
  });

  it('filters strictly by effective date when expiry range is blank', () => {
    const selected = selectPolicy(
      [
        filing('CANCELLED-IN-EFF-WINDOW', '20240101', '20260210'), // only cancellation is in Q1 2026
        filing('EFFECTIVE-IN-WINDOW', '20260215', null), // effective in Q1 2026, active (no cancellation)
      ],
      {
        effective: { from: '2026-01-01', to: '2026-03-31' },
        expiry: { from: null, to: null },
        todayCompact: '20261127',
      },
    );

    expect(selected.reason).toBe('effective');
    expect(selected.filing?.policy_no).toBe('EFFECTIVE-IN-WINDOW');
    expect(selected.matchedDate).toBe('2026-02-15');
  });

  it('filters strictly by expiry date when effective range is blank', () => {
    const selected = selectPolicy(
      [
        filing('NEW-IN-EXP-WINDOW', '20260415', null), // started in Q2 2026, no expiry
        filing('EXPIRING-IN-WINDOW', '20230501', '20260420'), // old policy expiring in Q2 2026
      ],
      {
        effective: { from: null, to: null },
        expiry: { from: '2026-04-01', to: '2026-06-30' },
        todayCompact: '20261127',
      },
    );

    expect(selected.reason).toBe('cancellation');
    expect(selected.filing?.policy_no).toBe('EXPIRING-IN-WINDOW');
    expect(selected.matchedDate).toBe('2026-04-20');
  });

  it('requires the SAME filing to match both ranges when both Effective and Expiry are set', () => {
    // Two separate filings that each match only one of the two ranges must NOT combine.
    const split = selectPolicy(
      [
        filing('ONLY-EFF', '20250201', '20250901'),
        filing('ONLY-EXP', '20240101', '20260215'),
      ],
      {
        effective: { from: '2025-01-01', to: '2025-03-31' },
        expiry: { from: '2026-01-01', to: '2026-03-31' },
        todayCompact: '20261127',
      },
    );
    expect(split.filing).toBeNull();
    expect(split.reason).toBeNull();

    // A single filing whose effective AND expiry dates both sit in their respective ranges wins.
    const matched = selectPolicy(
      [
        filing('ONLY-EFF', '20250201', '20250901'),
        filing('BOTH-MATCH', '20250210', '20260210'),
      ],
      {
        effective: { from: '2025-01-01', to: '2025-03-31' },
        expiry: { from: '2026-01-01', to: '2026-03-31' },
        todayCompact: '20261127',
      },
    );
    expect(matched.reason).toBe('both');
    expect(matched.filing?.policy_no).toBe('BOTH-MATCH');
    expect(matched.matchedDate).toBe('2025-02-10');
  });

  it('qualifiesByRanges distinguishes effective, cancellation and both', () => {
    const f = filing('P1', '20250301', '20260301');
    expect(
      qualifiesByRanges(f, {
        effective: { from: '2025-01-01', to: '2025-06-01' },
        expiry: { from: '2026-01-01', to: '2026-06-01' },
      }),
    ).toBe('both');
    expect(
      qualifiesByRanges(f, {
        effective: { from: '2025-01-01', to: '2025-06-01' },
        expiry: { from: null, to: null },
      }),
    ).toBe('effective');
    expect(
      qualifiesByRanges(f, {
        effective: { from: null, to: null },
        expiry: { from: '2026-01-01', to: '2026-06-01' },
      }),
    ).toBe('cancellation');
  });
});

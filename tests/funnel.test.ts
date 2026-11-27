import { describe, expect, it } from 'vitest';
import { buildFunnel, DROP_LABELS, STAGE_LABELS, type DropReason } from '@/lib/leads/funnel';

const base = {
  dateMode: 'policy' as const,
  censusCount: 1_424,
  inspected: 100,
  returned: 60,
  matched: 60,
  limit: 250,
};

describe('buildFunnel', () => {
  it('accounts for every carrier: inspected = returned + dropped', () => {
    const funnel = buildFunnel({
      ...base,
      drops: { no_filings: 20, out_of_range: 15, lapsed_cover: 5 },
    });

    expect(funnel.entered).toBe(100);
    expect(funnel.returned).toBe(60);
    expect(funnel.dropped).toBe(40);
    expect(funnel.balanced).toBe(true);
    expect(funnel.entered - funnel.dropped - funnel.returned).toBe(0);
  });

  it('reconciles the stage list to the same total', () => {
    const funnel = buildFunnel({ ...base, drops: { no_filings: 20, out_of_range: 15, lapsed_cover: 5 } });
    const returnedStage = funnel.stages.find((stage) => stage.key === 'returned');
    expect(returnedStage?.count).toBe(60);

    // Each stage's "remaining" is what survived it.
    const lastRemaining = funnel.stages[funnel.stages.length - 1].remaining;
    expect(lastRemaining).toBe(60);
  });

  it('reports each drop reason with a readable label and a share', () => {
    const funnel = buildFunnel({ ...base, drops: { no_filings: 30, out_of_range: 10 } });

    expect(funnel.drops.map((drop) => drop.reason)).toEqual(['no_filings', 'out_of_range']);
    expect(funnel.drops[0].label).toBe(DROP_LABELS.no_filings);
    expect(funnel.drops[0].count).toBe(30);
    expect(funnel.drops[0].share).toBeCloseTo(0.75);
    expect(funnel.drops[1].share).toBeCloseTo(0.25);
  });

  it('names the biggest reason in the summary', () => {
    const funnel = buildFunnel({ ...base, drops: { no_filings: 30, out_of_range: 10 } });
    expect(funnel.topDrop?.reason).toBe('no_filings');
    expect(funnel.summary).toContain('removed 30 of the 100 carriers');
    expect(funnel.summary).toContain('no insurance filing on file');
  });

  it('omits reasons with a zero count', () => {
    const funnel = buildFunnel({ ...base, drops: { no_filings: 40, out_of_range: 0 } });
    expect(funnel.drops).toHaveLength(1);
    expect(funnel.stages.some((stage) => stage.key === 'drop:out_of_range')).toBe(false);
  });

  it('shows the limit as its own stage when results are capped', () => {
    const funnel = buildFunnel({ ...base, inspected: 500, drops: {}, returned: 250, matched: 400, limit: 250 });

    const limitStage = funnel.stages.find((stage) => stage.key === 'limit');
    expect(limitStage?.count).toBe(150);
    expect(limitStage?.label).toBe('Held back by the limit');
  });

  it('does not invent a limit stage when nothing was truncated', () => {
    const funnel = buildFunnel({ ...base, drops: {} });
    expect(funnel.stages.some((stage) => stage.key === 'limit')).toBe(false);
  });

  it('handles the case where every carrier was filtered out', () => {
    const funnel = buildFunnel({ ...base, inspected: 40, drops: { no_filings: 40 }, returned: 0, matched: 0 });
    expect(funnel.summary).toBe('All 40 carriers were filtered out — the largest rule was no insurance filing on file.');
    expect(funnel.drops[0].share).toBe(1);
  });

  it('handles an empty pipeline without dividing by zero', () => {
    const funnel = buildFunnel({ ...base, censusCount: 0, inspected: 0, drops: {}, returned: 0, matched: 0 });
    expect(funnel.balanced).toBe(true);
    expect(funnel.summary).toBe('No carrier reached the insurance step for these filters.');
    expect(funnel.drops).toEqual([]);
    expect(funnel.topDrop).toBeNull();
  });

  it('starts at the census count when it is known', () => {
    const funnel = buildFunnel({ ...base, drops: {} });
    expect(funnel.stages[0].key).toBe('census');
    expect(funnel.stages[0].count).toBe(1_424);
  });

  it('skips the census stage when the count could not be read', () => {
    const funnel = buildFunnel({ ...base, censusCount: null, drops: {} });
    expect(funnel.stages[0].key).toBe('inspected');
  });

  it('labels the insurance step by the date mode', () => {
    const policy = buildFunnel({ ...base, drops: {} });
    const registration = buildFunnel({ ...base, dateMode: 'registration', drops: {} });
    expect(policy.stages.find((s) => s.key === 'inspected')?.detail).toContain('policy starts or ends');
    expect(registration.stages.find((s) => s.key === 'inspected')?.detail).toContain('insurance check');
  });

  it('never reports a negative remaining count', () => {
    const funnel = buildFunnel({ ...base, inspected: 10, drops: { no_filings: 50 }, returned: 0, matched: 0 });
    for (const stage of funnel.stages) {
      expect(stage.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('flags a pipeline that does not reconcile', () => {
    // More dropped than entered can only be a counting bug.
    const funnel = buildFunnel({ ...base, inspected: 10, drops: { no_filings: 50 }, returned: 0, matched: 0 });
    expect(funnel.balanced).toBe(false);
  });

  it('reconciles on a tiny result set', () => {
    // Regression: proportional buckets rounded independently used to overshoot
    // on small numbers (4 checked, 3 returned, 2+1 dropped = 5), which tripped
    // the "does not reconcile" warning on a perfectly normal search.
    for (let inspected = 1; inspected <= 12; inspected += 1) {
      const returned = Math.min(Math.max(inspected - 1, 0), inspected);
      const dropped = inspected - returned;
      const a = Math.floor(dropped / 2);
      const funnel = buildFunnel({
        dateMode: 'policy',
        censusCount: inspected,
        inspected,
        drops: { no_filings: a, out_of_range: dropped - a },
        returned,
        matched: returned,
        limit: 250,
      });
      expect(funnel.balanced).toBe(true);
      expect(funnel.entered - funnel.dropped - funnel.returned).toBe(0);
    }
  });

  it('keeps shares summing to one across every bucket', () => {
    const funnel = buildFunnel({
      ...base,
      drops: { no_filings: 10, out_of_range: 5, lapsed_cover: 4, expired_before_to: 3, has_cover: 2, unmapped: 1 },
    });
    const total = funnel.drops.reduce((sum, drop) => sum + drop.share, 0);
    expect(total).toBeCloseTo(1);
  });

  it('has a short stage label for every reason', () => {
    const reasons: DropReason[] = [
      'lookup_failed',
      'no_filings',
      'out_of_range',
      'lapsed_cover',
      'expired_before_to',
      'has_cover',
      'unmapped',
    ];
    for (const reason of reasons) {
      expect(STAGE_LABELS[reason]).toBeTruthy();
      expect(DROP_LABELS[reason]).toBeTruthy();
    }
  });
});

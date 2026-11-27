/**
 * Date-window rules for a lead search.
 *
 * The one promise this module exists to keep: the dates shown in a row must be
 * the dates that put the row in the result. A carrier may only appear because of
 * a filing that falls inside the requested date filter(s), and the columns must
 * show that same filing — never the carrier's newest policy from a different year.
 *
 * Effective date and Expiry (cancellation) date can be filtered separately:
 *   - Effective range only: a filing qualifies when its `effective_date` sits
 *     inside the Effective range.
 *   - Expiry range only: a filing qualifies when its `cancl_effective_date`
 *     sits inside the Expiry range.
 *   - Both Effective and Expiry ranges set: a filing qualifies only when its
 *     `effective_date` sits inside the Effective range AND its
 *     `cancl_effective_date` sits inside the Expiry range.
 *   - Legacy single-window `{ from, to }`: qualifies when either end sits
 *     inside `[from, to]`.
 *
 * Within qualifying filings:
 *   1. Earliest qualifying date wins, so the list reads in ascending date order
 *      starting from the user's "From" bound.
 *   2. Live cover breaks a tie on the same date.
 *   3. Fallback ("current" filing) is only allowed for a registration search
 *      with no expiry filter, where the census registration date is what matched.
 */

export type Row = Record<string, unknown>;

/** Inclusive date range bound; null on either side leaves that bound open. */
export interface DateBound {
  from: string | null;
  to: string | null;
}

export interface LeadDateRanges {
  /** Policy effective date range (or census add_date in registration mode). */
  effective: DateBound;
  /** Policy expiring / cancellation date range. */
  expiry: DateBound;
}

/** How a filing earned its place in the result. */
export type MatchReason = 'effective' | 'cancellation' | 'both' | 'current';

export interface SelectedPolicy {
  filing: Row | null;
  reason: MatchReason | null;
  /** Live cover today (no cancellation, or a cancellation still in the future). */
  hasActiveCoverage: boolean;
  /** Date that placed the row in the window, ISO yyyy-mm-dd. Null for 'current'. */
  matchedDate: string | null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** FMCSA dates are yyyymmdd; compare them as compact strings so no timezone sneaks in. */
export function compact(isoDate: string | null | undefined): string {
  return String(isoDate ?? '').replace(/\D/g, '').slice(0, 8);
}

/** True when at least one side of a DateBound carries a complete calendar date. */
export function hasDateBound(bound?: DateBound | null): boolean {
  if (!bound) return false;
  return compact(bound.from).length === 8 || compact(bound.to).length === 8;
}

/**
 * Inclusive range test against a potentially open-ended DateBound.
 * Returns false when `bound` is empty or `date` is missing/partial.
 */
export function withinDateBound(date: string | null | undefined, bound?: DateBound | null): boolean {
  if (!hasDateBound(bound) || !bound) return false;
  const value = compact(date);
  if (value.length !== 8) return false;
  const start = compact(bound.from);
  const end = compact(bound.to);
  if (start.length === 8 && value < start) return false;
  if (end.length === 8 && value > end) return false;
  return true;
}

/**
 * Inclusive range test. Accepts ISO ("2026-04-01") or compact ("20260401") on
 * any argument: comparing an uncompacted date against a compact bound is a
 * string comparison of "2026-04-01" vs "20251101", and "-" sorts below every
 * digit — silent wrong answers. Normalising here removes that trap.
 */
export function withinWindow(date: string | null | undefined, from: string, to: string): boolean {
  const value = compact(date);
  const start = compact(from);
  const end = compact(to);
  return value.length === 8 && start.length === 8 && end.length === 8 && value >= start && value <= end;
}

export function isLive(filing: Row, todayCompact: string): boolean {
  const cancellation = compact(text(filing.cancl_effective_date));
  return !cancellation || cancellation > todayCompact;
}

/** Which end of the filing falls inside a legacy single range, if any. */
export function qualifiesByWindow(
  filing: Row,
  from: string,
  to: string,
): 'effective' | 'cancellation' | null {
  if (withinWindow(text(filing.effective_date), from, to)) return 'effective';
  if (withinWindow(text(filing.cancl_effective_date), from, to)) return 'cancellation';
  return null;
}

/**
 * Test a single filing against separate Effective and Expiry ranges.
 * When both ranges are set, the same filing must satisfy both.
 */
export function qualifiesByRanges(
  filing: Row,
  ranges: LeadDateRanges,
): 'effective' | 'cancellation' | 'both' | null {
  const checkEffective = hasDateBound(ranges.effective);
  const checkExpiry = hasDateBound(ranges.expiry);

  if (checkEffective && checkExpiry) {
    const effOk = withinDateBound(text(filing.effective_date), ranges.effective);
    const expOk = withinDateBound(text(filing.cancl_effective_date), ranges.expiry);
    return effOk && expOk ? 'both' : null;
  }

  if (checkEffective) {
    return withinDateBound(text(filing.effective_date), ranges.effective) ? 'effective' : null;
  }

  if (checkExpiry) {
    return withinDateBound(text(filing.cancl_effective_date), ranges.expiry) ? 'cancellation' : null;
  }

  return null;
}

/** Best filing on the carrier's record today, ignoring the requested range. */
export function currentFiling(filings: readonly Row[], todayCompact: string): Row | null {
  let best: Row | null = null;
  for (const filing of filings) {
    if (!best) {
      best = filing;
      continue;
    }
    const bestLive = isLive(best, todayCompact);
    const thisLive = isLive(filing, todayCompact);
    if (bestLive !== thisLive) {
      if (thisLive) best = filing;
      continue;
    }
    if (compact(text(filing.effective_date)) > compact(text(best.effective_date))) best = filing;
  }
  return best;
}

/** Negative when `a` starts earlier than `b` — earliest in the window wins. */
function earlierEffectiveFirst(a: Row, b: Row): number {
  const left = compact(text(a.effective_date)) || '99999999';
  const right = compact(text(b.effective_date)) || '99999999';
  return left.localeCompare(right);
}

function sameEffectiveDate(a: Row, b: Row): boolean {
  return compact(text(a.effective_date)) === compact(text(b.effective_date));
}

function soonestCancellationFirst(a: Row, b: Row): number {
  const left = compact(text(a.cancl_effective_date)) || '99999999';
  const right = compact(text(b.cancl_effective_date)) || '99999999';
  return left.localeCompare(right);
}

function sameCancellationDate(a: Row, b: Row): boolean {
  return compact(text(a.cancl_effective_date)) === compact(text(b.cancl_effective_date));
}

export interface SelectOptions {
  /** Legacy single-window bounds, ISO yyyy-mm-dd. */
  from?: string;
  to?: string;
  /** Separate policy effective date range. */
  effective?: DateBound | null;
  /** Separate policy expiring / cancellation date range. */
  expiry?: DateBound | null;
  /** Today as yyyymmdd, used to decide whether cover is still live. */
  todayCompact: string;
  /**
   * Registration searches describe the census record, so a carrier with no
   * filing inside the range may still be shown with its current policy.
   * Defaults to false: showing an out-of-range policy is the bug this module
   * exists to prevent, so it has to be asked for explicitly.
   */
  allowCurrentFallback?: boolean;
}

/**
 * Pick the filing to display for one carrier, and say why it qualified.
 * Returns a null filing when nothing fits the range(s).
 */
export function selectPolicy(filings: readonly Row[], options: SelectOptions): SelectedPolicy {
  const { from, to, effective, expiry, todayCompact, allowCurrentFallback } = options;
  const useSeparateRanges = effective !== undefined || expiry !== undefined;

  if (useSeparateRanges) {
    const ranges: LeadDateRanges = {
      effective: effective ?? { from: null, to: null },
      expiry: expiry ?? { from: null, to: null },
    };

    let bestBoth: Row | null = null;
    let bestEffective: Row | null = null;
    let bestCancellation: Row | null = null;
    let hasActiveCoverage = false;

    for (const filing of filings) {
      if (isLive(filing, todayCompact)) hasActiveCoverage = true;

      const reason = qualifiesByRanges(filing, ranges);
      if (reason === 'both') {
        if (!bestBoth) {
          bestBoth = filing;
        } else if (earlierEffectiveFirst(filing, bestBoth) < 0) {
          bestBoth = filing;
        } else if (sameEffectiveDate(filing, bestBoth)) {
          if (soonestCancellationFirst(filing, bestBoth) < 0) {
            bestBoth = filing;
          } else if (sameCancellationDate(filing, bestBoth) && !isLive(bestBoth, todayCompact) && isLive(filing, todayCompact)) {
            bestBoth = filing;
          }
        }
      } else if (reason === 'effective') {
        if (!bestEffective) {
          bestEffective = filing;
        } else if (earlierEffectiveFirst(filing, bestEffective) < 0) {
          bestEffective = filing;
        } else if (sameEffectiveDate(filing, bestEffective)) {
          if (!isLive(bestEffective, todayCompact) && isLive(filing, todayCompact)) bestEffective = filing;
        }
      } else if (reason === 'cancellation') {
        if (!bestCancellation) {
          bestCancellation = filing;
        } else if (soonestCancellationFirst(filing, bestCancellation) < 0) {
          bestCancellation = filing;
        } else if (sameCancellationDate(filing, bestCancellation)) {
          if (!isLive(bestCancellation, todayCompact) && isLive(filing, todayCompact)) bestCancellation = filing;
        }
      }
    }

    if (bestBoth) {
      return {
        filing: bestBoth,
        reason: 'both',
        hasActiveCoverage,
        matchedDate: isoFromCompact(text(bestBoth.effective_date)),
      };
    }

    if (bestEffective) {
      return {
        filing: bestEffective,
        reason: 'effective',
        hasActiveCoverage,
        matchedDate: isoFromCompact(text(bestEffective.effective_date)),
      };
    }

    if (bestCancellation) {
      return {
        filing: bestCancellation,
        reason: 'cancellation',
        hasActiveCoverage,
        matchedDate: isoFromCompact(text(bestCancellation.cancl_effective_date)),
      };
    }

    if (allowCurrentFallback) {
      const current = currentFiling(filings, todayCompact);
      return {
        filing: current,
        reason: current ? 'current' : null,
        hasActiveCoverage,
        matchedDate: null,
      };
    }

    return { filing: null, reason: null, hasActiveCoverage, matchedDate: null };
  }

  let bestEffective: Row | null = null;
  let bestCancellation: Row | null = null;
  let hasActiveCoverage = false;

  for (const filing of filings) {
    if (isLive(filing, todayCompact)) hasActiveCoverage = true;

    const reason = from && to ? qualifiesByWindow(filing, from, to) : null;
    if (reason === 'effective') {
      if (!bestEffective) {
        bestEffective = filing;
      } else if (earlierEffectiveFirst(filing, bestEffective) < 0) {
        bestEffective = filing;
      } else if (sameEffectiveDate(filing, bestEffective)) {
        // Same date: prefer the filing that is still running.
        if (!isLive(bestEffective, todayCompact) && isLive(filing, todayCompact)) bestEffective = filing;
      }
    } else if (reason === 'cancellation') {
      if (!bestCancellation) {
        bestCancellation = filing;
      } else if (soonestCancellationFirst(filing, bestCancellation) < 0) {
        bestCancellation = filing;
      } else if (sameCancellationDate(filing, bestCancellation)) {
        if (!isLive(bestCancellation, todayCompact) && isLive(filing, todayCompact)) bestCancellation = filing;
      }
    }
  }

  if (bestEffective) {
    return {
      filing: bestEffective,
      reason: 'effective',
      hasActiveCoverage,
      matchedDate: isoFromCompact(text(bestEffective.effective_date)),
    };
  }

  if (bestCancellation) {
    return {
      filing: bestCancellation,
      reason: 'cancellation',
      hasActiveCoverage,
      matchedDate: isoFromCompact(text(bestCancellation.cancl_effective_date)),
    };
  }

  if (allowCurrentFallback) {
    const current = currentFiling(filings, todayCompact);
    return {
      filing: current,
      reason: current ? 'current' : null,
      hasActiveCoverage,
      matchedDate: null,
    };
  }

  return { filing: null, reason: null, hasActiveCoverage, matchedDate: null };
}

function isoFromCompact(value: string | null): string | null {
  const digits = compact(value);
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * Date used to order one row: the date that qualified it, so the list reads in
 * the same order as the range instead of by registration date.
 */
export function sortKey(selected: SelectedPolicy, addDate: string | null): string {
  return selected.matchedDate ?? addDate ?? '';
}

/** Ascending by the qualifying date — "From" first, blanks last. */
export function compareLeads(
  a: { sortDate: string | null; dot: string },
  b: { sortDate: string | null; dot: string },
): number {
  const left = a.sortDate ?? '';
  const right = b.sortDate ?? '';
  if (left && !right) return -1;
  if (!left && right) return 1;
  if (left !== right) return left.localeCompare(right);
  return Number(a.dot) - Number(b.dot);
}

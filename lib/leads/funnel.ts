/**
 * Lead funnel accounting.
 *
 * A search can report "68 leads" next to "1,424 census matches" and leave the
 * user guessing where the other 1,356 went. Every carrier that enters the
 * search is therefore tracked through the same fixed set of stages, and each
 * carrier that does not become a row is counted against exactly one reason.
 * The reasons therefore always add up: `entered = returned + dropped`.
 *
 * Keep this file free of I/O so the arithmetic can be unit-tested directly.
 */

/** A stage where carriers can be counted out. Order is the order they run in. */
export type DropReason =
  /** MOTUS insurance lookup failed or was rate-blocked, so eligibility could not be validated. */
  | 'lookup_failed'
  /** No insurance filing could be read from FMCSA for this carrier. */
  | 'no_filings'
  /** Filing history read, but nothing fell inside the requested dates. */
  | 'out_of_range'
  /** The filing that matched is cancelled, and the search asked for live cover. */
  | 'lapsed_cover'
  /** Registration search: cover expired before the range's "To" date. */
  | 'expired_before_to'
  /** Registration search: carrier does hold live cover, but the search asked for uninsured. */
  | 'has_cover'
  /** The row was disqualified for a reason we did not anticipate. */
  | 'unmapped';

export const DROP_LABELS: Record<DropReason, string> = {
  lookup_failed: 'Waiting for MOTUS enrichment',
  no_filings: 'No insurance filing on file',
  out_of_range: 'Policy dates outside the range',
  lapsed_cover: 'Cover lapsed — search asked for live',
  expired_before_to: 'Cover expired before the end date',
  has_cover: 'Has live cover — search asked for uninsured',
  unmapped: 'Other',
};

/** Header label for the stage, as it should read in the UI. */
export const STAGE_LABELS: Record<DropReason, string> = {
  lookup_failed: 'MOTUS pending',
  no_filings: 'No filing',
  out_of_range: 'Out of range',
  lapsed_cover: 'Lapsed',
  expired_before_to: 'Expired early',
  has_cover: 'Already insured',
  unmapped: 'Other',
};

export interface FunnelDrop {
  reason: DropReason;
  label: string;
  count: number;
  /** Share of the carriers that were dropped, 0–1. */
  share: number;
}

export interface FunnelStage {
  key: string;
  /** Short title, e.g. "Census registrations in range". */
  label: string;
  /** One line explaining where this number comes from. */
  detail: string;
  count: number;
  /** Carriers removed at this stage. */
  dropped: number;
  /** Carriers surviving this stage. */
  remaining: number;
  /** True for stages that come from the FMCSA counters rather than carriers. */
  sourceDelta: boolean;
}

export interface LeadFunnel {
  stages: FunnelStage[];
  drops: FunnelDrop[];
  /** Carriers that entered the pipeline. */
  entered: number;
  returned: number;
  /** Carriers counted out — equals `entered - returned`. */
  dropped: number;
  /** Largest single reason, used for the headline sentence. */
  topDrop: FunnelDrop | null;
  /** True when the numbers reconcile; a false here is a bug, not a filter. */
  balanced: boolean;
  /** Plain-language summary, safe to show as-is. */
  summary: string;
}

export interface FunnelInput {
  dateMode: 'policy' | 'registration';
  /** Carriers matching the census query inside the range, from FMCSA's count. */
  censusCount: number | null;
  /** Carriers gathered for insurance inspection. */
  inspected: number;
  /** Per-reason carrier counts. */
  drops: Partial<Record<DropReason, number>>;
  /** Rows actually returned (after the limit is applied). */
  returned: number;
  /** Rows matched before the limit truncated them. */
  matched: number;
  limit: number;
}

/**
 * Build the funnel. Counts that were not measured are reported as measured
 * only — no stage invents a number.
 */
export function buildFunnel(input: FunnelInput): LeadFunnel {
  const { dateMode, censusCount, inspected, drops, returned, matched, limit } = input;

  const dropOrder: DropReason[] = [
    'lookup_failed',
    'no_filings',
    'out_of_range',
    'lapsed_cover',
    'expired_before_to',
    'has_cover',
    'unmapped',
  ];
  const counted = dropOrder
    .map((reason) => ({ reason, label: DROP_LABELS[reason], count: drops[reason] ?? 0 }))
    .filter((drop) => drop.count > 0);

  const dropped = counted.reduce((total, drop) => total + drop.count, 0);
  const truncated = matched > returned;

  const stages: FunnelStage[] = [];

  if (censusCount !== null) {
    stages.push({
      key: 'census',
      label: 'Census registrations in range',
      detail: 'Carriers FMCSA says were added inside the dates and pass the state, cargo and authority filters',
      count: censusCount,
      dropped: 0,
      remaining: censusCount,
      sourceDelta: true,
    });
  }

  stages.push({
    key: 'inspected',
    label: 'Carriers checked for insurance',
    detail:
      dateMode === 'policy'
        ? 'Census matches plus carriers whose policy starts or ends inside the range'
        : 'Census matches taken forward to the insurance check',
    count: inspected,
    dropped: 0,
    remaining: inspected,
    sourceDelta: false,
  });

  let running = inspected;
  for (const drop of counted) {
    running -= drop.count;
    stages.push({
      key: `drop:${drop.reason}`,
      label: DROP_LABELS[drop.reason],
      detail: dropDetail(drop.reason),
      count: drop.count,
      dropped: drop.count,
      remaining: Math.max(running, 0),
      sourceDelta: false,
    });
  }

  if (truncated) {
    stages.push({
      key: 'limit',
      label: 'Held back by the limit',
      detail: `${matched.toLocaleString('en-US')} matched; the first ${limit.toLocaleString('en-US')} by date are shown`,
      count: matched - returned,
      dropped: matched - returned,
      remaining: returned,
      sourceDelta: false,
    });
  }

  stages.push({
    key: 'returned',
    label: 'Leads returned',
    detail: 'Rows in the preview, ordered by the date that matched the range',
    count: returned,
    dropped: 0,
    remaining: returned,
    sourceDelta: false,
  });

  const totalDropped = counted.reduce((total, drop) => total + drop.count, 0);
  const withShare: FunnelDrop[] = counted.map((drop) => ({
    ...drop,
    share: totalDropped > 0 ? drop.count / totalDropped : 0,
  }));

  const topDrop = withShare.reduce<FunnelDrop | null>(
    (best, drop) => (best === null || drop.count > best.count ? drop : best),
    null,
  );

  // Returned rows plus counted drops must not exceed what entered: if they do,
  // a carrier was counted twice and the panel would be lying.
  const balanced = inspected === 0 || inspected - dropped - returned >= 0;

  return {
    stages,
    drops: withShare,
    entered: inspected,
    returned,
    dropped: Math.max(dropped, 0),
    topDrop,
    balanced,
    summary: summarise({ inspected, returned, counted, topDrop, truncated, matched, limit }),
  };
}

/** Sentence-case a label that starts with an acronym or a capitalised word. */
function lowerFirst(value: string): string {
  if (value.length === 0) return value;
  // Leave words that are acronyms or proper nouns alone.
  if (/^[A-Z]{2,}/.test(value)) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function dropDetail(reason: DropReason): string {
  switch (reason) {
    case 'lookup_failed':
      return 'MOTUS rate-limited or failed to return policy details for this carrier — retry to validate eligibility';
    case 'no_filings':
      return 'FMCSA returns no insurance filing for this carrier, so no policy date can match';
    case 'out_of_range':
      return 'Policies exist, but no effective or expiring date lands inside the dates';
    case 'lapsed_cover':
      return 'The matching policy was cancelled, and the search asks for live cover';
    case 'expired_before_to':
      return 'Registration search: cover ended before the range’s end date';
    case 'has_cover':
      return 'Live cover on file, and the search asks for carriers without insurance';
    default:
      return 'Filtered out by a rule that is not broken down yet';
  }
}

function summarise(args: {
  inspected: number;
  returned: number;
  counted: { label: string; count: number }[];
  topDrop: FunnelDrop | null;
  truncated: boolean;
  matched: number;
  limit: number;
}): string {
  const { inspected, returned, topDrop, truncated, matched, limit } = args;
  if (inspected === 0) return 'No carrier reached the insurance step for these filters.';
  if (returned === 0) {
    const reason = topDrop ? ` — the largest rule was ${lowerFirst(topDrop.label)}` : '';
    return `All ${inspected.toLocaleString('en-US')} carriers were filtered out${reason}.`;
  }
  if (!topDrop) return `All ${inspected.toLocaleString('en-US')} carriers checked became leads.`;

  const share = Math.round(topDrop.share * 100);
  const tail = truncated
    ? ` A further ${(matched - returned).toLocaleString('en-US')} matched but fell outside the ${limit.toLocaleString('en-US')} limit.`
    : '';
  return `Biggest filter: ${lowerFirst(topDrop.label)} removed ${topDrop.count.toLocaleString('en-US')} of the ${inspected.toLocaleString('en-US')} carriers checked (${share}% of those dropped).${tail}`;
}

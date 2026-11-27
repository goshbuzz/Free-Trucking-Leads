/**
 * Pure allocation policy for a single monthly period. This module does not
 * enforce quotas by itself: the caller must authenticate the user, obtain a
 * trusted client IP, lock and update persistent usage in one transaction, and
 * apply it to every response path before any carrier data is exposed.
 */
export type LeadPlan = 'free' | 'monthly' | 'unlimited';
export const MONTHLY_LEAD_LIMITS: Record<LeadPlan, number | null> = {
  free: 200,
  monthly: 5000,
  unlimited: null,
};

export interface QuotaInput {
  plan: LeadPlan;
  /** Already exposed carrier IDs for this account in the current period. */
  accountSeen: ReadonlySet<string>;
  /** Free-tier carrier IDs exposed to any account from this IP in the period. */
  ipSeen: ReadonlySet<string>;
  /** Ordered canonical carrier IDs (USDOT numbers). */
  requested: readonly string[];
}

export interface QuotaAllocation {
  allowed: string[];
  denied: string[];
  newAccountIds: string[];
  newIpIds: string[];
}

/** Repeated IDs are returned once and do not consume additional quota. */
export function allocateMonthlyLeads({ plan, accountSeen, ipSeen, requested }: QuotaInput): QuotaAllocation {
  const account = new Set(accountSeen);
  const ip = new Set(ipSeen);
  const processed = new Set<string>();
  const allowed: string[] = [];
  const denied: string[] = [];
  const newAccountIds: string[] = [];
  const newIpIds: string[] = [];
  const limit = MONTHLY_LEAD_LIMITS[plan];

  for (const id of requested) {
    if (!/^\d+$/.test(id) || /^0+$/.test(id)) throw new Error('Expected a canonical USDOT number.');
    // Normalise numeric IDs so zero padding cannot create duplicate charges.
    const dot = id.replace(/^0+/, '');
    if (processed.has(dot)) continue;
    processed.add(dot);
    if (account.has(dot)) { allowed.push(dot); continue; }
    const accountFull = limit !== null && account.size >= limit;
    const ipFull = plan === 'free' && !ip.has(dot) && ip.size >= MONTHLY_LEAD_LIMITS.free!;
    if (accountFull || ipFull) { denied.push(dot); continue; }
    account.add(dot);
    newAccountIds.push(dot);
    if (plan === 'free' && !ip.has(dot)) { ip.add(dot); newIpIds.push(dot); }
    allowed.push(dot);
  }
  return { allowed, denied, newAccountIds, newIpIds };
}

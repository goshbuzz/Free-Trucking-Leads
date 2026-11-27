/**
 * Turn a finished batch into a single actionable explanation.
 *
 * A 315-row upload where *every* row failed is an infrastructure problem, and
 * repeating "FMCSA lookup failed" 315 times hides that. This collapses the run
 * into a cause, an owner (you vs. FMCSA) and the next step.
 */

import type { CarrierEnrichment, EnrichResponse } from './types';

export type RunCause =
  | 'none'
  | 'no_key'
  | 'key_rejected'
  | 'rate_limited'
  | 'unreachable'
  | 'upstream_error'
  | 'no_insurance_data'
  | 'dot_not_in_census'
  | 'partial_failures';

export interface RunDiagnosis {
  cause: RunCause;
  severity: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
  /** Concrete next action, or null when there is nothing to do. */
  action: string | null;
  /** Which side has to act. */
  owner: 'you' | 'fmcsa' | 'nobody';
}

export function diagnoseRun(response: EnrichResponse): RunDiagnosis {
  const rows = response.results;
  const total = rows.length;

  if (total === 0) {
    return {
      cause: 'none',
      severity: 'info',
      title: 'Nothing to enrich',
      detail: 'The file produced no USDOT values to look up.',
      action: 'Check that the DOT column is populated.',
      owner: 'you',
    };
  }

  const count = (status: CarrierEnrichment['status']) => rows.filter((row) => row.status === status).length;
  const retry = count('retry');
  const found = rows.filter((row) => row.lookup.fmcsa === 'ok').length;
  const notFound = count('not_found');
  const invalid = count('invalid');
  const withPolicy = rows.filter((row) => row.policy?.policyNumber).length;
  const insuranceNotQueried = rows.filter((row) => row.lookup.insurance === 'not_found').length;

  // Every row that could be looked up failed.
  if (retry > 0 && found === 0) {
    const reason = dominantFailureReason(rows);

    if (reason.includes('not configured') || reason.includes('key is not configured')) {
      return {
        cause: 'no_key',
        severity: 'error',
        title: 'No FMCSA API key on the server',
        detail:
          'Every row was skipped because the deployment has no FMCSA webKey. Environment variables added after a deployment do not apply to it.',
        action: 'Add FMCSA_WEB_KEY in Vercel → Settings → Environment Variables, then redeploy.',
        owner: 'you',
      };
    }

    if (
      reason.includes('429') ||
      /rate limit|request-rate|access denied|waf|motus/i.test(reason)
    ) {
      return {
        cause: 'rate_limited',
        severity: 'error',
        title: 'MOTUS / FMCSA rate-limited the run',
        detail: `Upstream enforced request-rate controls before lookups could finish: ${reason}`,
        action:
          'Automatic pacing and 403 cooldown are active. Wait a few seconds and retry; add SOCRATA_APP_TOKEN or lower ENRICH_CONCURRENCY (e.g. 2–3) in Vercel if needed.',
        owner: 'you',
      };
    }

    if (reason.includes('403') || reason.includes('401')) {
      return {
        cause: 'key_rejected',
        severity: 'error',
        title: 'FMCSA rejected the API key',
        detail: `Every lookup returned an authorisation error. Upstream said: ${reason}`,
        action:
          'Confirm the key is active on mobile.fmcsa.dot.gov and matches the deployed value. Open /api/status?probe=1 to test it directly.',
        owner: 'you',
      };
    }

    if (/timed out|Network error|Could not reach|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(reason)) {
      return {
        cause: 'unreachable',
        severity: 'error',
        title: 'The server could not reach FMCSA',
        detail: `No request completed. Upstream said: ${reason}`,
        action:
          'Check that your deployment can make outbound HTTPS requests to mobile.fmcsa.dot.gov. A firewall, proxy or regional block on the function causes exactly this.',
        owner: 'you',
      };
    }

    return {
      cause: 'upstream_error',
      severity: 'error',
      title: 'FMCSA failed every lookup',
      detail: `Upstream said: ${reason}`,
      action: 'This is very likely an FMCSA outage. Retry later and check /api/status?probe=1.',
      owner: 'fmcsa',
    };
  }

  if (retry > 0) {
    return {
      cause: 'partial_failures',
      severity: 'warn',
      title: `${retry} of ${total} lookups failed`,
      detail: `The rest completed. Failed rows are marked "Needs retry" and keep their place in the export. Upstream said: ${dominantFailureReason(
        rows,
      )}`,
      action: 'Re-run the failed DOTs, or lower ENRICH_CONCURRENCY if the cause was rate limiting.',
      owner: 'you',
    };
  }

  if (found > 0 && withPolicy === 0 && insuranceNotQueried === total) {
    return {
      cause: 'no_insurance_data',
      severity: 'warn',
      title: 'Carriers found, but no insurance filings are published',
      detail:
        'Registration and contact data resolved for these DOTs, yet every insurance dataset came back empty. FMCSA only publishes coverages an insurer has actually filed, so this is legitimate for new authorities and many private carriers.',
      action: 'Nothing to fix — Policy Number, Effective Date and Expiration Date stay blank by design.',
      owner: 'nobody',
    };
  }

  if (notFound === total) {
    return {
      cause: 'dot_not_in_census',
      severity: 'warn',
      title: 'FMCSA has no record of these DOT numbers',
      detail: `The API answered correctly but matched none of the ${total} numbers.`,
      action: 'Verify the numbers are USDOT identifiers rather than MC/MX docket numbers.',
      owner: 'you',
    };
  }

  if (invalid === total) {
    return {
      cause: 'dot_not_in_census',
      severity: 'warn',
      title: 'No valid USDOT numbers in the file',
      detail: 'Every value in the DOT column failed validation.',
      action: 'Use digits only (up to 8), for example 1234567. MC/MX dockets are a different identifier.',
      owner: 'you',
    };
  }

  return {
    cause: 'none',
    severity: 'info',
    title: 'Run completed',
    detail: `${found} of ${total} DOT numbers resolved at FMCSA.`,
    action: null,
    owner: 'nobody',
  };
}

/** Pick the most common failure note so the message reflects the real cause. */
function dominantFailureReason(rows: readonly CarrierEnrichment[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'retry') continue;
    const note = row.notes[0] ?? 'FMCSA lookup failed.';
    counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? 'FMCSA lookup failed.';
}

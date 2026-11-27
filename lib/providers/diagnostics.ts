/**
 * Failure diagnosis for "every row failed".
 *
 * When a whole upload fails rather than a few DOT numbers, the cause is almost
 * never the data — it is one of: the function cannot reach FMCSA, the key is
 * wrong/not deployed, FMCSA is rejecting the request shape, or FMCSA is down.
 * Those need completely different fixes, so this module tests them separately
 * instead of reporting one opaque "lookup failed" per row.
 */

import { FMCSA_BASE_URL, resolveFmcsaKey } from '../env';
import { fetchJson } from '../http';
import { parseQcCarrier } from './fmcsa';

export type DiagnosisCode =
  | 'ok'
  | 'no_key'
  | 'key_rejected'
  | 'rate_limited'
  | 'unreachable'
  | 'upstream_error'
  | 'unexpected_shape'
  | 'dot_not_found';

export interface Diagnosis {
  code: DiagnosisCode;
  ok: boolean;
  /** One line an operator can act on. */
  message: string;
  status?: number;
  latencyMs?: number;
  envVar?: string | null;
  /** Raw upstream body, truncated — the fastest way to spot an HTML block page. */
  sample?: string;
}

/** A DOT that exists in the FMCSA census, used only to prove the key works. */
const PROBE_DOT = process.env.FMCSA_PROBE_DOT ?? '1515240';

export async function diagnoseFmcsa(signal?: AbortSignal): Promise<Diagnosis> {
  const resolved = resolveFmcsaKey();
  if (!resolved) {
    return {
      code: 'no_key',
      ok: false,
      envVar: null,
      message:
        'No FMCSA webKey found in the environment. Add FMCSA_WEB_KEY in your Vercel project settings and redeploy — environment variables only apply to new deployments.',
    };
  }

  const url = `${FMCSA_BASE_URL}/carriers/${PROBE_DOT}?webKey=${encodeURIComponent(resolved.key)}`;
  const result = await fetchJson<unknown>(url, { signal, timeoutMs: 15_000, retries: 0 });

  if (!result.ok) {
    if (result.status === 0) {
      return {
        code: 'unreachable',
        ok: false,
        status: 0,
        latencyMs: result.latencyMs,
        envVar: resolved.envVar,
        message: `Could not reach ${FMCSA_BASE_URL}. This is a network/timeout problem, not a key problem: ${
          result.error ?? 'connection failed'
        }`,
      };
    }
    if (result.status === 429 || (result.status === 403 && result.rateLimited)) {
      return {
        code: 'rate_limited',
        ok: false,
        status: result.status,
        latencyMs: result.latencyMs,
        envVar: resolved.envVar,
        message: `FMCSA / Akamai WAF rate-limited this deployment (HTTP ${result.status}). Automatic pacing and 403 cooldown are active — retry after a brief pause or lower ENRICH_CONCURRENCY.`,
        sample: result.error ?? undefined,
      };
    }
    if (result.status === 401 || result.status === 403) {
      return {
        code: 'key_rejected',
        ok: false,
        status: result.status,
        latencyMs: result.latencyMs,
        envVar: resolved.envVar,
        message: `FMCSA rejected the webKey in ${resolved.envVar} (HTTP ${result.status}). Confirm the key in Vercel matches the one on mobile.fmcsa.dot.gov and that it has not expired.`,
        sample: result.error ?? undefined,
      };
    }
    if (result.status === 429) {
      return {
        code: 'rate_limited',
        ok: false,
        status: 429,
        latencyMs: result.latencyMs,
        envVar: resolved.envVar,
        message:
          'FMCSA rate-limited this deployment (HTTP 429). Lower ENRICH_CONCURRENCY (try 3–4), or retry shortly.',
      };
    }
    if (result.status === 404) {
      return {
        code: 'dot_not_found',
        ok: false,
        status: 404,
        latencyMs: result.latencyMs,
        envVar: resolved.envVar,
        message: `The key was accepted but probe DOT ${PROBE_DOT} returned no record (HTTP 404). The API is reachable; per-row results depend on the DOT numbers submitted.`,
      };
    }
    return {
      code: 'upstream_error',
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      envVar: resolved.envVar,
      message: `FMCSA returned HTTP ${result.status} for the probe DOT. ${
        result.status >= 500 ? 'This is an FMCSA-side outage — retry later.' : 'Check the request shape and key.'
      }`,
      sample: result.error ?? undefined,
    };
  }

  const carrier = parseQcCarrier(result.data, PROBE_DOT);
  if (!carrier) {
    return {
      code: 'unexpected_shape',
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      envVar: resolved.envVar,
      message:
        'The key was accepted and FMCSA answered, but the payload had no carrier object. This is usually an FMCSA outage or a gateway/proxy HTML page.',
      sample: safeSample(result.data),
    };
  }

  return {
    code: 'ok',
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    envVar: resolved.envVar,
    message: `Key works — probe DOT ${PROBE_DOT} resolved to "${carrier.legalName ?? 'unnamed carrier'}" in ${result.latencyMs} ms.`,
  };
}

function safeSample(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Upstream HTTP helpers: controlled per-host request pacing, automatic
 * cooldown after HTTP 403 / 429 blocks, bounded retries, and a concurrency pool.
 *
 * Why pacing and 403 cooldown live here:
 *   MOTUS (data.transportation.gov) and FMCSA QCMobile (mobile.fmcsa.dot.gov,
 *   fronted by Akamai WAF) enforce strict request-rate controls. Concurrent
 *   un-paced bursts trigger Akamai HTTP 403 "Access Denied" blocks or HTTP 429
 *   throttling. Spacing outbound requests per host and pausing all queued
 *   requests during a post-403 cooldown stops a transient block from cascading
 *   across an entire batch.
 */

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  latencyMs: number;
  /** True when the failure came from an upstream rate-limit or WAF 403 block. */
  rateLimited?: boolean;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

interface HostPaceState {
  nextAllowedAt: number;
  cooldownUntil: number;
  consecutiveBlocks: number;
}

const hostStates = new Map<string, HostPaceState>();

function defaultMinIntervalMs(): number {
  if (process.env.UPSTREAM_MIN_INTERVAL_MS !== undefined) {
    const parsed = Number(process.env.UPSTREAM_MIN_INTERVAL_MS);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return process.env.NODE_ENV === 'test' ? 0 : 120;
}

function defaultCooldownBaseMs(): number {
  if (process.env.UPSTREAM_403_COOLDOWN_MS !== undefined) {
    const parsed = Number(process.env.UPSTREAM_403_COOLDOWN_MS);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return process.env.NODE_ENV === 'test' ? 40 : 1_500;
}

function hostKey(rawUrl: string): string {
  try {
    return new URL(rawUrl).host.toLowerCase() || 'default';
  } catch {
    return 'default';
  }
}

function getHostState(host: string): HostPaceState {
  let state = hostStates.get(host);
  if (!state) {
    state = { nextAllowedAt: 0, cooldownUntil: 0, consecutiveBlocks: 0 };
    hostStates.set(host, state);
  }
  return state;
}

/** Diagnostic / test snapshot of a host's pacing & cooldown state. */
export function getHostPaceSnapshot(url: string): Readonly<HostPaceState> {
  return { ...getHostState(hostKey(url)) };
}

/** Clear per-host pacing timers (used by unit tests). */
export function resetHostPacing(): void {
  hostStates.clear();
}

/**
 * Reserve the next request slot on `host`, respecting both steady-state pacing
 * (`minIntervalMs`) and any active 403/429 cooldown window (`cooldownUntil`).
 */
async function waitForHostSlot(
  host: string,
  minIntervalMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  while (true) {
    if (signal?.aborted) return false;
    const state = getHostState(host);
    const now = Date.now();

    if (state.cooldownUntil > now) {
      const ok = await sleep(state.cooldownUntil - now, signal);
      if (!ok) return false;
      continue;
    }

    if (minIntervalMs <= 0) return true;

    const scheduledAt = Math.max(now, state.nextAllowedAt);
    state.nextAllowedAt = scheduledAt + minIntervalMs;
    if (scheduledAt > now) {
      const ok = await sleep(scheduledAt - now, signal);
      if (!ok) return false;
      // Re-check in case another in-flight request triggered a 403 cooldown while we waited.
      if (getHostState(host).cooldownUntil > Date.now()) continue;
    }
    return true;
  }
}

function recordHostBlock(host: string, explicitWaitMs: number | null, cooldownBaseMs: number): number {
  const state = getHostState(host);
  state.consecutiveBlocks += 1;
  const computed =
    explicitWaitMs !== null && explicitWaitMs > 0
      ? Math.min(explicitWaitMs, 15_000)
      : Math.min(cooldownBaseMs * 2 ** Math.min(state.consecutiveBlocks - 1, 3), 12_000);
  const until = Date.now() + computed;
  if (until > state.cooldownUntil) state.cooldownUntil = until;
  if (until > state.nextAllowedAt) state.nextAllowedAt = until;
  return computed;
}

function recordHostSuccess(host: string): void {
  const state = getHostState(host);
  state.consecutiveBlocks = 0;
}

/**
 * Distinguish an Akamai / MOTUS / Socrata rate-control 403 from an explicit
 * QCMobile invalid-API-key 403.
 *
 * MOTUS / Socrata requests carry no `webKey` at all, so any 403 there is an
 * upstream access/rate block. On QCMobile (`webKey=`), Akamai WAF blocks return
 * HTML ("Access Denied", "Reference #", "edgesuite") rather than a JSON message
 * about the key.
 */
export function isRateControl403(url: string, body: string): boolean {
  const hasWebKey = /[?&]webKey=/i.test(url);
  if (!hasWebKey) return true;
  if (!body.trim()) return true;
  if (/access denied|reference\s*#|akamai|edgesuite|<!doctype|<html|rate\s*limit|too many|throttl|temporarily blocked/i.test(body)) {
    return true;
  }
  return false;
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** Minimum spacing in ms between requests to the same host. */
  minIntervalMs?: number;
  /** Base cooldown in ms applied when a host responds with HTTP 403 / 429. */
  cooldownBaseMs?: number;
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<FetchResult<T>> {
  const {
    headers = {},
    timeoutMs = 12_000,
    retries = 2,
    signal,
    minIntervalMs = defaultMinIntervalMs(),
    cooldownBaseMs = defaultCooldownBaseMs(),
  } = options;
  const started = Date.now();
  const host = hostKey(url);
  let lastError: string | null = null;
  let lastStatus = 0;
  let wasRateLimited = false;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) {
      return { ok: false, status: 0, data: null, error: 'Request cancelled', latencyMs: Date.now() - started };
    }

    const ready = await waitForHostSlot(host, minIntervalMs, signal);
    if (!ready) {
      return { ok: false, status: 0, data: null, error: 'Request cancelled', latencyMs: Date.now() - started };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'FMCSA-Lead-Desk/1.1 (+https://data.transportation.gov)',
          ...headers,
        },
        signal: controller.signal,
        cache: 'no-store',
      });

      lastStatus = response.status;

      if (response.ok) {
        recordHostSuccess(host);
        const text = await response.text();
        if (!text.trim()) {
          return { ok: true, status: response.status, data: null, error: null, latencyMs: Date.now() - started };
        }
        try {
          return {
            ok: true,
            status: response.status,
            data: JSON.parse(text) as T,
            error: null,
            latencyMs: Date.now() - started,
          };
        } catch {
          return {
            ok: false,
            status: response.status,
            data: null,
            error: 'Upstream returned a response that was not JSON (an HTML error page is a common cause)',
            latencyMs: Date.now() - started,
          };
        }
      }

      if (response.status === 404) {
        recordHostSuccess(host);
      }

      const body = await safeText(response);
      const rateControl403 = response.status === 403 && isRateControl403(url, body);
      const isThrottle = response.status === 429 || rateControl403;
      if (isThrottle) wasRateLimited = true;

      lastError = describeStatus(response.status, body, url, rateControl403);

      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const retryAfterMs =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null;

      if (isThrottle) {
        const cooldownMs = recordHostBlock(host, retryAfterMs, cooldownBaseMs);
        if (attempt === retries) {
          return {
            ok: false,
            status: response.status,
            data: null,
            error: lastError,
            latencyMs: Date.now() - started,
            rateLimited: true,
          };
        }
        const ok = await sleep(Math.min(cooldownMs, 10_000), signal);
        if (!ok) {
          return { ok: false, status: 0, data: null, error: 'Request cancelled', latencyMs: Date.now() - started };
        }
        continue;
      }

      if (!RETRY_STATUS.has(response.status) || attempt === retries) {
        return {
          ok: false,
          status: response.status,
          data: null,
          error: lastError,
          latencyMs: Date.now() - started,
          rateLimited: wasRateLimited,
        };
      }

      const wait = retryAfterMs !== null ? retryAfterMs : backoff(attempt);
      const ok = await sleep(Math.min(wait, 6_000), signal);
      if (!ok) {
        return { ok: false, status: 0, data: null, error: 'Request cancelled', latencyMs: Date.now() - started };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      lastError = signal?.aborted
        ? 'Request cancelled'
        : aborted
          ? `Upstream timed out after ${timeoutMs}ms`
          : `Network error: ${error instanceof Error ? error.message : String(error)}`;
      lastStatus = 0;
      if (signal?.aborted || attempt === retries) {
        return {
          ok: false,
          status: 0,
          data: null,
          error: lastError,
          latencyMs: Date.now() - started,
          rateLimited: wasRateLimited,
        };
      }
      await sleep(backoff(attempt), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    data: null,
    error: lastError,
    latencyMs: Date.now() - started,
    rateLimited: wasRateLimited,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '';
  }
}

function describeStatus(status: number, body: string, url: string, rateControl403: boolean): string {
  switch (status) {
    case 401:
      return 'FMCSA rejected the API key (HTTP 401). Check that the FMCSA webKey in your Vercel environment is valid and active.';
    case 403:
      if (rateControl403) {
        const source = /[?&]webKey=/i.test(url) ? 'FMCSA / Akamai WAF' : 'MOTUS open-data endpoint';
        return `${source} returned HTTP 403 Access Denied (request-rate control). Automatic cooldown and pacing were applied.`;
      }
      return 'FMCSA rejected the API key (HTTP 403). Check that the FMCSA webKey in your Vercel environment is valid and active.';
    case 404:
      return 'Not found (HTTP 404)';
    case 429:
      return 'Rate limited by the upstream API (HTTP 429)';
    default:
      if (status >= 500) return `Upstream error (HTTP ${status})`;
      return `Upstream responded HTTP ${status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
  }
}

function backoff(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 20 * 2 ** attempt;
  const base = 300 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

/** Abort-aware sleep. Resolves `false` immediately if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run `worker` over `items` with a fixed concurrency limit, preserving order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

/** Chunk an array into fixed-size batches. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

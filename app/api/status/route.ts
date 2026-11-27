import { NextResponse } from 'next/server';
import { probeFmcsa, isFmcsaConfigured } from '@/lib/providers/fmcsa';
import { diagnoseFmcsa } from '@/lib/providers/diagnostics';
import { probeMotus } from '@/lib/providers/motus';
import { MOTUS_BASE_URL, MOTUS_DATASETS, maskKey, resolveFmcsaKey, resolveMotusToken, limits, FMCSA_BASE_URL, isMotusEnabled } from '@/lib/env';
import type { ProviderStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/status            — configuration only (no upstream calls)
 * GET /api/status?probe=1    — also makes one cheap call to each provider
 *
 * Never returns the key itself: only which variable matched and its last four
 * characters, so a misconfigured deployment can be diagnosed in one request.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shouldProbe = url.searchParams.get('probe') === '1';
  const key = resolveFmcsaKey();
  const motusToken = resolveMotusToken();

  const status: ProviderStatus = {
    fmcsa: {
      configured: isFmcsaConfigured(),
      envVar: key?.envVar ?? null,
      masked: key ? maskKey(key.key) : null,
      baseUrl: FMCSA_BASE_URL,
    },
    motus: {
      configured: isMotusEnabled(),
      envVar: motusToken?.envVar ?? null,
      baseUrl: MOTUS_BASE_URL,
      datasets: { ...MOTUS_DATASETS },
    },
    limits: limits(),
  };

  if (shouldProbe) {
    const [fmcsa, motus, diagnosis] = await Promise.all([
      probeFmcsa(request.signal),
      probeMotus(request.signal),
      diagnoseFmcsa(request.signal),
    ]);
    status.probe = {
      ok: fmcsa.ok && motus.ok,
      fmcsa,
      motus,
      // Separates "no key" from "key rejected" from "cannot reach FMCSA" from
      // "FMCSA is down" — each needs a different fix.
      diagnosis: {
        code: diagnosis.code,
        message: diagnosis.message,
        status: diagnosis.status,
        latencyMs: diagnosis.latencyMs,
        envVar: diagnosis.envVar,
      },
    };
  }

  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}

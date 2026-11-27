import { Enricher } from '@/components/Enricher';
import { limits, isMockMode } from '@/lib/env';
import { isFmcsaConfigured } from '@/lib/providers/fmcsa';

export const dynamic = 'force-dynamic';

/**
 * Server-rendered on every request so the API-key warning is visible in the
 * first paint — a missing key must never be discoverable only after a failed run.
 */
export default function HomePage() {
  const limit = limits();
  return (
    <Enricher
      maxRows={limit.maxRowsPerFile}
      maxFileBytes={limit.maxFileBytes}
      mockMode={isMockMode()}
      serverHasKey={isFmcsaConfigured()}
    />
  );
}

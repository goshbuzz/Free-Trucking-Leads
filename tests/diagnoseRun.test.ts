import { describe, expect, it } from 'vitest';
import { diagnoseRun } from '@/lib/diagnoseRun';
import type { CarrierEnrichment, EnrichResponse } from '@/lib/types';

const row = (over: Partial<CarrierEnrichment>): CarrierEnrichment => ({
  dot: '1000000',
  status: 'enriched',
  legalName: 'ACME LLC',
  dbaName: null,
  contactName: 'A Person',
  phone: '(214) 555-1234',
  phoneE164: '+12145551234',
  email: 'a@acme.com',
  createdEdt: '2014-02-01 19:00:00 UTC-5',
  mcs150Date: null,
  street: null,
  city: null,
  state: null,
  zip: null,
  usdotStatus: 'AUTHORIZED',
  powerUnits: null,
  drivers: null,
  policy: null,
  policies: [],
  sources: [],
  notes: [],
  missing: [],
  needsCorrection: false,
  lookup: { fmcsa: 'ok', census: 'ok', insurance: 'ok' },
  ...over,
});

const response = (results: CarrierEnrichment[]): EnrichResponse => ({
  results,
  meta: {
    requested: results.length,
    returned: results.length,
    fmcsaConfigured: true,
    motusOk: true,
    elapsedMs: 10,
    warnings: [],
  },
});

const failed = (note: string, count = 3) =>
  Array.from({ length: count }, (_, i) =>
    row({ dot: String(1000 + i), status: 'retry', lookup: { fmcsa: 'error', census: 'skipped', insurance: 'skipped' }, notes: [note] }),
  );

describe('diagnoseRun', () => {
  it('identifies a missing API key across a total failure', () => {
    const result = diagnoseRun(response(failed('FMCSA API key is not configured on the server, so this DOT was not looked up.')));
    expect(result.cause).toBe('no_key');
    expect(result.owner).toBe('you');
    expect(result.action).toContain('redeploy');
  });

  it('identifies a rejected key', () => {
    const result = diagnoseRun(response(failed('FMCSA rejected the API key (HTTP 403). Check that the FMCSA webKey in your Vercel environment is valid and active.')));
    expect(result.cause).toBe('key_rejected');
    expect(result.action).toContain('/api/status');
  });

  it('identifies rate limiting and suggests a concurrency change', () => {
    const result = diagnoseRun(response(failed('Rate limited by the upstream API (HTTP 429)')));
    expect(result.cause).toBe('rate_limited');
    expect(result.action).toContain('ENRICH_CONCURRENCY');
  });

  it('classifies MOTUS / Akamai HTTP 403 request-rate blocks as rate_limited rather than key_rejected', () => {
    const result = diagnoseRun(
      response(
        failed(
          'MOTUS open-data endpoint returned HTTP 403 Access Denied (request-rate control). Automatic cooldown and pacing were applied.',
        ),
      ),
    );
    expect(result.cause).toBe('rate_limited');
  });

  it('identifies a network block rather than blaming the data', () => {
    const result = diagnoseRun(response(failed('Network error: fetch failed')));
    expect(result.cause).toBe('unreachable');
    expect(result.detail).toContain('fetch failed');
  });

  it('attributes a 5xx outage to FMCSA', () => {
    const result = diagnoseRun(response(failed('Upstream error (HTTP 503)')));
    expect(result.cause).toBe('upstream_error');
    expect(result.owner).toBe('fmcsa');
  });

  it('separates "carriers found but no insurance published" from a failure', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({
        dot: String(2000 + i),
        status: 'partial',
        policy: null,
        lookup: { fmcsa: 'ok', census: 'ok', insurance: 'not_found' },
      }),
    );
    const result = diagnoseRun(response(rows));
    expect(result.cause).toBe('no_insurance_data');
    expect(result.owner).toBe('nobody');
    expect(result.action).toContain('Nothing to fix');
  });

  it('reports a file that contains no valid DOT numbers', () => {
    const rows = [row({ dot: 'MC123', status: 'invalid' }), row({ dot: '', status: 'invalid' })];
    const result = diagnoseRun(response(rows));
    expect(result.cause).toBe('dot_not_in_census');
    expect(result.action).toContain('digits only');
  });

  it('reports a partial failure with a count', () => {
    const rows = [...failed('Upstream timed out after 12000ms', 2), row({ dot: '9' })];
    const result = diagnoseRun(response(rows));
    expect(result.cause).toBe('partial_failures');
    expect(result.title).toContain('2 of 3');
  });

  it('says nothing alarming on a clean run', () => {
    const result = diagnoseRun(response([row({}), row({ dot: '2' })]));
    expect(result.cause).toBe('none');
    expect(result.action).toBeNull();
  });
});

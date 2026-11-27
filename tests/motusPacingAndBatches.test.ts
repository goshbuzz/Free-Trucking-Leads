import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, getHostPaceSnapshot, isRateControl403, resetHostPacing } from '@/lib/http';
import { enrichDots, enrichOne } from '@/lib/enrich';
import { searchLeads } from '@/lib/leads/search';
import { DEFAULT_FILTERS } from '@/lib/leads/filters';
import { POST as postLeads } from '@/app/api/leads/route';

const originalFetch = global.fetch;

beforeEach(() => {
  resetHostPacing();
  delete process.env.MOCK_FMCSA;
});

afterEach(() => {
  global.fetch = originalFetch;
  resetHostPacing();
  vi.restoreAllMocks();
});

describe('controlled request pacing & HTTP 403 cooldown (lib/http)', () => {
  it('distinguishes Akamai / MOTUS rate-control 403 from invalid QCMobile API keys', () => {
    expect(isRateControl403('https://data.transportation.gov/resource/c5y8-a4uz.json', 'Access Denied')).toBe(true);
    expect(
      isRateControl403(
        'https://mobile.fmcsa.dot.gov/qc/services/carriers/1515240?webKey=abc',
        '<html><title>Access Denied</title>Reference #18.abc.edgesuite.net</html>',
      ),
    ).toBe(true);
    expect(
      isRateControl403(
        'https://mobile.fmcsa.dot.gov/qc/services/carriers/1515240?webKey=bad',
        '{"content":"Webkey is invalid or inactive"}',
      ),
    ).toBe(false);
  });

  it('spaces concurrent requests to the same host using minIntervalMs', async () => {
    const timestamps: number[] = [];
    global.fetch = vi.fn(async () => {
      timestamps.push(Date.now());
      return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
    }) as unknown as typeof fetch;

    await Promise.all([
      fetchJson('https://data.transportation.gov/resource/c5y8-a4uz.json?$limit=1', { minIntervalMs: 35, retries: 0 }),
      fetchJson('https://data.transportation.gov/resource/c5y8-a4uz.json?$limit=2', { minIntervalMs: 35, retries: 0 }),
      fetchJson('https://data.transportation.gov/resource/c5y8-a4uz.json?$limit=3', { minIntervalMs: 35, retries: 0 }),
    ]);

    expect(timestamps).toHaveLength(3);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(25);
    expect(timestamps[2] - timestamps[0]).toBeGreaterThanOrEqual(55);
  });

  it('applies automatic host cooldown after HTTP 403 Access Denied and recovers on retry', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('<html><title>Access Denied</title></html>', { status: 403 });
      }
      return new Response(JSON.stringify([{ dot_number: '1515240' }]), { status: 200 });
    }) as unknown as typeof fetch;

    const url = 'https://data.transportation.gov/resource/az4n-8mr2.json?$limit=1';
    const result = await fetchJson<Array<{ dot_number: string }>>(url, {
      retries: 2,
      cooldownBaseMs: 45,
      minIntervalMs: 0,
    });

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.data?.[0]?.dot_number).toBe('1515240');
    expect(getHostPaceSnapshot(url).consecutiveBlocks).toBe(0);
  });

  it('does not retry an explicit invalid QCMobile webKey 403', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('{"content":"Invalid webKey"}', { status: 403 });
    }) as unknown as typeof fetch;

    const result = await fetchJson(
      'https://mobile.fmcsa.dot.gov/qc/services/carriers/1515240?webKey=wrong',
      { retries: 2, cooldownBaseMs: 20, minIntervalMs: 0 },
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.rateLimited).toBe(false);
    expect(result.error).toContain('FMCSA rejected the API key');
  });
});

describe('incomplete batch protection & duplicate protection', () => {
  it('marks a carrier as retry (never complete/partial) when MOTUS insurance lookup fails', async () => {
    const row = await enrichOne('1515240', {
      fmcsaConfigured: false,
      useMock: false,
      census: {
        dot: '1515240',
        legalName: 'EXAMPLE CARRIER LLC',
        dbaName: null,
        email: 'ops@example.com',
        phone: '2145551234',
        officer: 'JANE DOE',
        addDate: '20260115',
        mcs150Date: '20260115',
        street: '100 MAIN ST',
        city: 'DALLAS',
        state: 'TX',
        zip: '75001',
        statusCode: 'A',
        powerUnits: 4,
        drivers: 4,
        dockets: ['MC123456'],
      },
      insurance: [],
      insuranceFailed: true,
    });

    expect(row.status).toBe('retry');
    expect(row.lookup.insurance).toBe('error');
    expect(row.notes[0]).toContain('Waiting for MOTUS enrichment');
  });

  it('prevents an enrichment batch with MOTUS 403 blocks from being marked complete and deduplicates DOTs', async () => {
    let censusRequests = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('az4n-8mr2')) {
        censusRequests += 1;
        return new Response(
          JSON.stringify([
            {
              dot_number: '1515240',
              legal_name: 'EXAMPLE CARRIER LLC',
              phone: '2145551234',
              email_address: 'ops@example.com',
              status_code: 'A',
            },
          ]),
          { status: 200 },
        );
      }
      // Simulate persistent MOTUS insurance HTTP 403 block across retries
      return new Response('Access Denied', { status: 403 });
    }) as unknown as typeof fetch;

    const response = await enrichDots(['1515240', '001515240', 'USDOT 1515240']);

    expect(censusRequests).toBe(1); // Duplicate DOTs collapsed to one lookup
    expect(response.results).toHaveLength(1);
    expect(response.results[0].status).toBe('retry');
    expect(response.meta.complete).toBe(false);
    expect(response.meta.pendingRetryCount).toBe(1);
    expect(response.meta.motusOk).toBe(false);
  });

  it('refuses to pass off a 100%-403 MOTUS lead search as "0 leads matched"', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      const select = parsed.searchParams.get('$select') ?? '';
      if (parsed.pathname.includes('az4n-8mr2') && select.includes('count(*)')) {
        return new Response(JSON.stringify([{ n: '2' }]), { status: 200 });
      }
      if (parsed.pathname.includes('az4n-8mr2')) {
        return new Response(
          JSON.stringify([
            { dot_number: '4000001', legal_name: 'ALPHA TRUCKING LLC', phy_state: 'TX', status_code: 'A', add_date: '20260201' },
          ]),
          { status: 200 },
        );
      }
      // MOTUS insurance endpoints blocked with 403
      return new Response('Access Denied', { status: 403 });
    }) as unknown as typeof fetch;

    const result = await searchLeads({
      filters: { ...DEFAULT_FILTERS, insurance: 'yes' },
      effective: { from: '2026-01-01', to: '2026-03-27' },
      expiry: { from: null, to: null },
      limit: 50,
      includeRejected: false,
    });

    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.unenrichedCount).toBe(1);
    expect(result.error).toContain('MOTUS');
  });
});

describe('searchLeads & POST /api/leads — separate Effective and Expiry date ranges', () => {
  it('filters live leads by both Effective Date range AND Expiry Date range on the same policy', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      const select = parsed.searchParams.get('$select') ?? '';
      const where = parsed.searchParams.get('$where') ?? '';

      if (select.includes('count(*)')) {
        return new Response(JSON.stringify([{ n: '2' }]), { status: 200 });
      }
      // Pass 2 on insuranceHistory must include BOTH effective_date and cancl_effective_date predicates
      if (
        parsed.pathname.includes('3uet-3z4i') &&
        where.includes('effective_date between') &&
        where.includes('cancl_effective_date between')
      ) {
        return new Response(
          JSON.stringify([
            {
              usdot_number: '5000001',
              policy_no: 'POL-MATCH',
              effective_date: '20250210',
              cancl_effective_date: '20260210',
              insurance_company_name: 'Great West Casualty',
              ins_form_code: 'BMC-91X',
              max_cov_amount: '1000000',
            },
            {
              usdot_number: '5000002',
              policy_no: 'POL-WRONG-EXP',
              effective_date: '20250210',
              cancl_effective_date: '20250901',
              insurance_company_name: 'Old Republic',
              ins_form_code: 'BMC-91X',
              max_cov_amount: '1000000',
            },
          ]),
          { status: 200 },
        );
      }
      if (parsed.pathname.includes('az4n-8mr2') && where.includes('dot_number in')) {
        return new Response(
          JSON.stringify([
            { dot_number: '5000001', legal_name: 'MATCHED CARRIER LLC', phy_state: 'TX', status_code: 'A', add_date: '20250201' },
            { dot_number: '5000002', legal_name: 'WRONG EXPIRY LLC', phy_state: 'TX', status_code: 'A', add_date: '20250201' },
          ]),
          { status: 200 },
        );
      }
      if (parsed.pathname.includes('az4n-8mr2')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (parsed.pathname.includes('c5y8-a4uz')) {
        return new Response(
          JSON.stringify([
            {
              usdot_number: '5000001',
              policy_no: 'POL-RENEWAL-2026',
              effective_date: '20260210',
              insurance_company_name: 'Great West Casualty',
              ins_form_code: 'BMC-91X',
              max_cov_amount: '1000000',
            },
          ]),
          { status: 200 },
        );
      }
      if (parsed.pathname.includes('3uet-3z4i')) {
        return new Response(
          JSON.stringify([
            {
              usdot_number: '5000001',
              policy_no: 'POL-MATCH',
              effective_date: '20250210',
              cancl_effective_date: '20260210',
              insurance_company_name: 'Great West Casualty',
              ins_form_code: 'BMC-91X',
              max_cov_amount: '1000000',
            },
            // Duplicate row in history to verify deduplication
            {
              usdot_number: '5000001',
              policy_no: 'POL-MATCH',
              effective_date: '20250210',
              cancl_effective_date: '20260210',
              insurance_company_name: 'Great West Casualty',
              ins_form_code: 'BMC-91X',
              max_cov_amount: '1000000',
            },
            {
              usdot_number: '5000002',
              policy_no: 'POL-WRONG-EXP',
              effective_date: '20250210',
              cancl_effective_date: '20250901',
              insurance_company_name: 'Old Republic',
              ins_form_code: 'BMC-91X',
              max_cov_amount: '1000000',
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await searchLeads({
      filters: { ...DEFAULT_FILTERS, insurance: 'yes' },
      effective: { from: '2025-01-01', to: '2025-03-31' },
      expiry: { from: '2026-01-01', to: '2026-03-31' },
      limit: 100,
      includeRejected: false,
    });

    expect(result.ok).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].dot).toBe('5000001');
    expect(result.rows[0].policyNumber).toBe('POL-MATCH');
    expect(result.rows[0].effectiveDate).toBe('2025-02-10');
    expect(result.rows[0].expiringDate).toBe('2026-02-10');
    expect(result.rows[0].matchReason).toBe('both');
    expect(result.rows[0].matchDateKind).toBe('both');
    expect(result.funnel.balanced).toBe(true);
  });

  it('validates separate Effective and Expiry ranges on POST /api/leads', async () => {
    process.env.MOCK_FMCSA = '1';

    // 1. Rejects when all four bounds are blank
    const emptyRes = await postLeads(
      new Request('http://localhost/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveFrom: '',
          effectiveTo: '',
          expiryFrom: '',
          expiryTo: '',
          filters: { ...DEFAULT_FILTERS, insurance: 'yes' },
        }),
      }),
    );
    expect(emptyRes.status).toBe(422);

    // 2. Rejects reversed Expiry bounds
    const reversedRes = await postLeads(
      new Request('http://localhost/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveFrom: null,
          effectiveTo: null,
          expiryFrom: '2026-05-01',
          expiryTo: '2026-04-01',
          filters: { ...DEFAULT_FILTERS, insurance: 'yes' },
        }),
      }),
    );
    expect(reversedRes.status).toBe(422);

    // 3. Succeeds with Expiry-only range
    const expiryOnlyRes = await postLeads(
      new Request('http://localhost/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveFrom: null,
          effectiveTo: null,
          expiryFrom: '2026-04-01',
          expiryTo: '2026-06-30',
          limit: 10,
          filters: { ...DEFAULT_FILTERS, insurance: 'yes' },
        }),
      }),
    );
    expect(expiryOnlyRes.status).toBe(200);
    const expiryPayload = await expiryOnlyRes.json();
    expect(expiryPayload.meta.effectiveFrom).toBeNull();
    expect(expiryPayload.meta.expiryFrom).toBe('2026-04-01');
    expect(expiryPayload.meta.expiryTo).toBe('2026-06-30');
    expect(expiryPayload.meta.complete).toBe(true);
    expect(expiryPayload.rows.length).toBeGreaterThan(0);
    expect(expiryPayload.rows[0].matchDateKind).toBe('expiring');
  });
});

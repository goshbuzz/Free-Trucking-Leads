/**
 * FMCSA "Motus" open-data client (data.transportation.gov, Socrata).
 *
 * Two reasons this exists alongside QCMobile:
 *  1. The Motor Carrier Census File is the only public FMCSA file that carries
 *     an email address and the registration ("added") date for every carrier.
 *  2. Motus Insur / InsHist carry policy number, effective date and — when the
 *     insurer has filed one — the cancellation date. QCMobile does not expose
 *     insurance at all.
 *
 * Both datasets are public-domain US DOT data and need no key. An app token is
 * optional; when present it raises the rate limit.
 */

import { MOTUS_BASE_URL, MOTUS_DATASETS, isMotusEnabled, resolveMotusToken } from '../env';
import { chunk, fetchJson } from '../http';
import { classifyInsurance, isActivePolicy, kindLabel, parseCoverage, parseFmcsaDate } from '../normalize';
import type { InsurancePolicy } from '../types';

const BATCH_SIZE = 40;
const PAGE_LIMIT = 4000;

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a SoQL query without trusting user input: only digits are placed in the
 * `in(...)` list, so a CSV cell can never inject query syntax.
 */
function soqlIn(field: string, dots: readonly string[]): string {
  const safe = dots.map((dot) => `'${dot.replace(/\D/g, '')}'`).filter((d) => d !== "''");
  return `${field} in(${safe.join(',')})`;
}

function buildUrl(dataset: string, params: Record<string, string>): string {
  const url = new URL(`${MOTUS_BASE_URL}/${dataset}.json`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const token = resolveMotusToken();
  if (token) url.searchParams.set('$$app_token', token.key);
  return url.toString();
}

async function queryDataset(
  dataset: string,
  where: string,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ rows: Row[]; ok: boolean; error?: string }> {
  const rows: Row[] = [];
  let offset = 0;

  while (true) {
    const url = buildUrl(dataset, {
      $where: where,
      $limit: String(Math.min(PAGE_LIMIT, 50_000)),
      $offset: String(offset),
      ...extra,
    });

    const result = await fetchJson<Row[]>(url, { signal, timeoutMs: 20_000, retries: 1 });
    if (!result.ok || !Array.isArray(result.data)) {
      return { rows, ok: rows.length > 0, error: result.error ?? 'Unexpected response shape' };
    }

    rows.push(...result.data);
    if (result.data.length < Math.min(PAGE_LIMIT, 50_000)) break;
    offset += result.data.length;
  }

  return { rows, ok: true };
}

/* -------------------------------------------------------------------------- */
/* Census                                                                     */
/* -------------------------------------------------------------------------- */

export interface CensusRecord {
  dot: string;
  legalName: string | null;
  dbaName: string | null;
  email: string | null;
  phone: string | null;
  officer: string | null;
  addDate: string | null;
  mcs150Date: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  statusCode: string | null;
  powerUnits: number | null;
  drivers: number | null;
  dockets: string[];
}

export interface CensusResult {
  byDot: Map<string, CensusRecord>;
  failedDots: Set<string>;
  ok: boolean;
  error?: string;
  warnings: string[];
}

export async function fetchCensusWithStatus(dots: readonly string[], signal?: AbortSignal): Promise<CensusResult> {
  const map = new Map<string, CensusRecord>();
  const failedDots = new Set<string>();
  const warnings: string[] = [];
  if (!isMotusEnabled() || dots.length === 0) {
    return { byDot: map, failedDots, ok: true, warnings };
  }

  let ok = true;
  let error: string | undefined;
  const unique = [...new Set(dots.map((dot) => dot.replace(/\D/g, '')).filter(Boolean))];

  for (const batch of chunk(unique, BATCH_SIZE)) {
    const result = await queryDataset(
      MOTUS_DATASETS.census,
      soqlIn('dot_number', batch),
      { $order: ':id' },
      signal,
    );

    if (!result.ok) {
      ok = false;
      error = result.error ?? 'MOTUS census lookup failed';
      batch.forEach((dot) => failedDots.add(dot));
      if (error && !warnings.includes(error)) warnings.push(error);
    }

    for (const row of result.rows) {
      const dot = text(row.dot_number)?.replace(/\D/g, '').replace(/^0+(?=\d)/, '') ?? null;
      if (!dot || map.has(dot)) continue;
      const docket = [text(row.docket1prefix), text(row.docket1)].filter(Boolean).join('');
      map.set(dot, {
        dot,
        legalName: text(row.legal_name),
        dbaName: text(row.dba_name),
        email: text(row.email_address),
        phone: text(row.phone),
        officer: text(row.company_officer_1),
        addDate: text(row.add_date),
        mcs150Date: text(row.mcs150_date),
        street: text(row.phy_street),
        city: text(row.phy_city),
        state: text(row.phy_state),
        zip: text(row.phy_zip),
        statusCode: text(row.status_code),
        powerUnits: num(row.power_units),
        drivers: num(row.total_drivers),
        dockets: docket ? [docket] : [],
      });
    }
  }

  return { byDot: map, failedDots, ok, error, warnings };
}

export async function fetchCensus(dots: readonly string[], signal?: AbortSignal): Promise<Map<string, CensusRecord>> {
  const result = await fetchCensusWithStatus(dots, signal);
  return result.byDot;
}

/* -------------------------------------------------------------------------- */
/* Insurance                                                                  */
/* -------------------------------------------------------------------------- */

function toPolicy(row: Row, source: InsurancePolicy['source'], today: string): InsurancePolicy | null {
  const policyNumber = text(row.policy_no);
  const formCode = text(row.ins_form_code);
  const typeCode = text(row.ins_type_code);
  const kind = classifyInsurance(formCode, typeCode);

  const effectiveDate = parseFmcsaDate(row.effective_date);
  const cancellationDate = parseFmcsaDate(row.cancl_effective_date);

  // A filing with no policy number and no coverage is not usable.
  if (!policyNumber && !text(row.insurance_company_name)) return null;

  const policy: InsurancePolicy = {
    formCode,
    typeCode,
    kind,
    kindLabel: kindLabel(kind),
    insurer: text(row.insurance_company_name),
    policyNumber,
    coverage: parseCoverage(row.max_cov_amount),
    effectiveDate,
    cancellationDate,
    transactionDate: parseFmcsaDate(row.trans_date),
    active: true,
    source,
  };
  policy.active = isActivePolicy(policy, today);
  return policy;
}

export interface InsuranceResult {
  byDot: Map<string, InsurancePolicy[]>;
  /** DOTs whose insurance history we could not read (so callers can retry). */
  failedDots: Set<string>;
  ok: boolean;
  error?: string;
  /** Non-fatal problems worth surfacing in the run diagnosis. */
  warnings: string[];
}

/**
 * Fetch insurance filings for a batch of DOTs.
 *
 * `insurance` holds active/pending filings; `insuranceHistory` holds terminated
 * and replaced ones, which is the only place a cancellation ("expiration") date
 * appears. Both are queried and merged.
 */
export async function fetchInsurance(dots: readonly string[], signal?: AbortSignal): Promise<InsuranceResult> {
  const byDot = new Map<string, InsurancePolicy[]>();
  const failedDots = new Set<string>();
  const warnings: string[] = [];
  if (!isMotusEnabled() || dots.length === 0) {
    return { byDot, failedDots, ok: true, warnings };
  }

  const today = new Date().toISOString().slice(0, 10);
  const unique = [...new Set(dots.map((dot) => dot.replace(/\D/g, '')).filter(Boolean))];
  const seenKeys = new Set<string>();
  let ok = true;
  let error: string | undefined;

  for (const batch of chunk(unique, BATCH_SIZE)) {
    // Query active and history sequentially through the host pacer so bursts do
    // not trip MOTUS / Akamai HTTP 403 rate controls.
    const active = await queryDataset(MOTUS_DATASETS.insurance, soqlIn('usdot_number', batch), { $order: ':id' }, signal);
    const history = await queryDataset(
      MOTUS_DATASETS.insuranceHistory,
      soqlIn('usdot_number', batch),
      { $order: ':id' },
      signal,
    );

    if (!active.ok || !history.ok) {
      ok = false;
      const failure = active.error ?? history.error ?? 'MOTUS insurance lookup failed';
      error = failure;
      batch.forEach((dot) => failedDots.add(dot));
      if (!warnings.includes(failure)) warnings.push(failure);
    }

    for (const [source, rows] of [
      ['motus-insur', active.rows],
      ['motus-inshist', history.rows],
    ] as const) {
      for (const row of rows) {
        const dot = text(row.usdot_number)?.replace(/\D/g, '').replace(/^0+(?=\d)/, '') ?? null;
        if (!dot) continue;
        const policy = toPolicy(row, source, today);
        if (!policy) continue;
        const dedupeKey = [
          dot,
          source,
          policy.policyNumber ?? '',
          policy.effectiveDate ?? '',
          policy.cancellationDate ?? '',
          policy.formCode ?? '',
        ].join('|');
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        const list = byDot.get(dot) ?? [];
        list.push(policy);
        byDot.set(dot, list);
      }
    }
  }

  return { byDot, failedDots, ok, error, warnings };
}

/* -------------------------------------------------------------------------- */
/* Probe                                                                      */
/* -------------------------------------------------------------------------- */

export async function probeMotus(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  if (!isMotusEnabled()) {
    return { ok: false, latencyMs: 0, message: 'Motus lookups disabled by MOTUS_ENABLED' };
  }

  // Check census and insurance separately: they fail independently, and a
  // silent insurance failure is exactly what produces blank policy columns.
  const targets: Array<[string, string]> = [
    ['census', MOTUS_DATASETS.census],
    ['insurance', MOTUS_DATASETS.insurance],
    ['insurance history', MOTUS_DATASETS.insuranceHistory],
  ];

  const results = await Promise.all(
    targets.map(async ([label, dataset]) => {
      const url = buildUrl(dataset, { $limit: '1' });
      const result = await fetchJson<Row[]>(url, { signal, timeoutMs: 15_000, retries: 0 });
      const ok = result.ok && Array.isArray(result.data);
      return { label, ok, latencyMs: result.latencyMs, error: result.error };
    }),
  );

  const failed = results.filter((r) => !r.ok);
  const slowest = Math.max(...results.map((r) => r.latencyMs));

  if (failed.length === 0) {
    return { ok: true, latencyMs: slowest, message: `All ${results.length} datasets reachable` };
  }

  return {
    ok: false,
    latencyMs: slowest,
    message: `${failed.map((f) => f.label).join(', ')} unreachable — ${failed[0].error ?? 'unknown error'}`,
  };
}

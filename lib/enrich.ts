/**
 * Enrichment pipeline: USDOT numbers in, one complete row per DOT out.
 *
 * Field-by-field merge order (also documented in the UI sidebar):
 *   1. FMCSA QCMobile carrier record — freshest registration data.
 *   2. FMCSA Motor Carrier Census File (Motus) — adds the filed email address,
 *      the "added" date and officer name.
 *   3. Motus Insur / InsHist — policy number, effective date and any filed
 *      cancellation date.
 *
 * Nothing is inferred: a blank in the export means FMCSA does not publish that
 * value, and the Notes column says why.
 */

import { mapPool } from './http';
import { isMockMode } from './env';
import {
  formatEastern,
  isActivePolicy,
  kindLabel,
  classifyInsurance,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  parseDot,
  usdotStatusLabel,
  parseFmcsaDate,
  rankPolicies,
  todayIso,
} from './normalize';
import { fetchCensusWithStatus, fetchInsurance, type CensusRecord } from './providers/motus';
import { fetchQcCarrier, isFmcsaConfigured, type QcCarrier } from './providers/fmcsa';
import { mockCarrierFor, mockPoliciesFor } from './mock';
import type { CarrierEnrichment, EnrichResponse, InsurancePolicy, LookupState } from './types';
import { diagnoseRun } from './diagnoseRun';

/** Default kept low (3) alongside per-host pacing so bursts do not trip Akamai HTTP 403 blocks. */
const CONCURRENCY = Math.max(1, Number(process.env.ENRICH_CONCURRENCY ?? 3));

export interface EnrichOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const CONTACT_FIELDS = [
  'Contact name',
  'Business name',
  'Phone',
  'Email',
  'Created (EDT)',
  'Policy Number',
  'Effective Date',
  'Expiration Date',
];

export async function enrichDots(inputs: readonly string[], options: EnrichOptions = {}): Promise<EnrichResponse> {
  const started = Date.now();
  const { signal, onProgress } = options;
  const warnings: string[] = [];
  const useMock = isMockMode();
  const fmcsaConfigured = isFmcsaConfigured() || useMock;

  if (!isFmcsaConfigured() && !useMock) {
    warnings.push(
      'No FMCSA webKey found in the environment. Registration, phone and email lookups are disabled — add FMCSA_WEB_KEY (or FMCSA_API_KEY) in Vercel and redeploy.',
    );
  }

  // Keep input order, drop duplicates, flag unusable cells.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const rows: CarrierEnrichment[] = [];

  for (const raw of inputs) {
    const dot = parseDot(raw);
    if (!dot) {
      rows.push(invalidRow(raw));
      continue;
    }
    if (seen.has(dot)) continue;
    seen.add(dot);
    ordered.push(dot);
  }

  let motusHealthy = !useMock;

  if (ordered.length > 0) {
    // Run MOTUS census then insurance sequentially through the host pacer rather
    // than firing simultaneous bursts against data.transportation.gov.
    const censusResult = useMock
      ? {
          byDot: new Map<string, CensusRecord>(),
          failedDots: new Set<string>(),
          ok: true,
          error: undefined as string | undefined,
          warnings: [] as string[],
        }
      : await fetchCensusWithStatus(ordered, signal);

    const insurance = useMock
      ? {
          byDot: new Map<string, InsurancePolicy[]>(),
          failedDots: new Set<string>(),
          ok: true,
          error: undefined as string | undefined,
          warnings: [] as string[],
        }
      : await fetchInsurance(ordered, signal);

    motusHealthy = useMock ? false : censusResult.ok && insurance.ok;

    if (!useMock && !censusResult.ok) {
      warnings.push(
        `MOTUS census lookup failed for ${censusResult.failedDots.size || 'some'} record(s) (${censusResult.error ?? 'unknown error'}). Incomplete records are marked "Needs retry" so the batch is not falsely marked complete.`,
      );
    }

    if (!useMock && !insurance.ok) {
      warnings.push(
        insurance.byDot.size === 0
          ? `Insurance datasets did not respond (${insurance.error ?? 'unknown error'}), so records remain "Needs retry" rather than being marked complete without policy details.`
          : `Some insurance lookups failed (${insurance.error ?? 'unknown error'}). Rows marked "Needs retry" are still waiting for MOTUS enrichment.`,
      );
    }
    for (const warning of [...(censusResult.warnings ?? []), ...(insurance.warnings ?? [])]) {
      if (!warnings.some((existing) => existing.includes(warning))) {
        warnings.push(`MOTUS dataset error: ${warning}`);
      }
    }

    const mockPolicies = new Map<string, InsurancePolicy[]>();
    if (useMock) {
      for (const dot of ordered) mockPolicies.set(dot, mockPoliciesFor(dot));
    }

    let done = 0;
    const enriched = await mapPool(ordered, CONCURRENCY, async (dot) => {
      const result = await enrichOne(dot, {
        fmcsaConfigured,
        useMock,
        census: censusResult.byDot.get(dot) ?? null,
        censusFailed: censusResult.failedDots.has(dot),
        insurance: insurance.byDot.get(dot) ?? mockPolicies.get(dot) ?? [],
        insuranceFailed: insurance.failedDots.has(dot),
        signal,
      });
      done += 1;
      onProgress?.(done, ordered.length);
      return result;
    });

    rows.push(...enriched);
  }

  const elapsedMs = Date.now() - started;
  if (elapsedMs > 50_000) {
    warnings.push(
      `This batch took ${(elapsedMs / 1000).toFixed(0)}s. Serverless functions time out at 60s — upload fewer rows per file or lower ENRICH_CONCURRENCY.`,
    );
  }

  const pendingRetryCount = rows.filter((row) => row.status === 'retry').length;
  const complete = pendingRetryCount === 0 && (useMock || motusHealthy);

  const response: EnrichResponse = {
    results: rows,
    meta: {
      requested: inputs.length,
      returned: rows.length,
      fmcsaConfigured,
      motusOk: motusHealthy,
      complete,
      pendingRetryCount,
      elapsedMs,
      warnings,
    },
  };
  response.meta.diagnosis = diagnoseRun(response);
  return response;
}

export interface SingleContext {
  fmcsaConfigured: boolean;
  useMock?: boolean;
  census: CensusRecord | null;
  censusFailed?: boolean;
  insurance: InsurancePolicy[];
  insuranceFailed?: boolean;
  signal?: AbortSignal;
}

function baseRow(dot: string, status: CarrierEnrichment['status']): CarrierEnrichment {
  return {
    dot,
    status,
    legalName: null,
    dbaName: null,
    contactName: null,
    phone: null,
    phoneE164: null,
    email: null,
    createdEdt: null,
    mcs150Date: null,
    street: null,
    city: null,
    state: null,
    zip: null,
    usdotStatus: null,
    powerUnits: null,
    drivers: null,
    policy: null,
    policies: [],
    sources: [],
    notes: [],
    missing: [],
    needsCorrection: false,
    lookup: { fmcsa: 'skipped', census: 'skipped', insurance: 'skipped' },
  };
}

function invalidRow(raw: string): CarrierEnrichment {
  const row = baseRow(String(raw ?? '').trim(), 'invalid');
  row.notes = [
    raw
      ? `"${String(raw).slice(0, 40)}" is not a USDOT number. Use the digits only (for example 1234567) — MC/MX docket numbers are a different identifier.`
      : 'Empty USDOT cell.',
  ];
  return row;
}

export async function enrichOne(dot: string, ctx: SingleContext): Promise<CarrierEnrichment> {
  const started = Date.now();
  const today = todayIso();
  const notes: string[] = [];

  let qc: { state: LookupState; carrier: QcCarrier | null; error: string | null };
  if (ctx.useMock) {
    const carrier = mockCarrierFor(dot);
    qc = carrier ? { state: 'ok', carrier, error: null } : { state: 'not_found', carrier: null, error: null };
  } else if (ctx.fmcsaConfigured) {
    qc = await fetchQcCarrier(dot, ctx.signal);
  } else {
    qc = { state: 'disabled', carrier: null, error: null };
  }

  const carrier = qc.carrier;
  const census = ctx.census;
  const censusState: LookupState = census
    ? 'ok'
    : ctx.censusFailed
      ? 'error'
      : ctx.useMock || !ctx.fmcsaConfigured
        ? 'skipped'
        : 'not_found';

  /* No record anywhere ---------------------------------------------------- */
  if (!carrier && !census) {
    if (qc.state === 'error' || ctx.censusFailed) {
      const row = baseRow(dot, 'retry');
      row.notes = [qc.error ?? 'MOTUS / FMCSA lookup failed — waiting for enrichment retry.'];
      row.lookup = { fmcsa: qc.state, census: censusState, insurance: ctx.insuranceFailed ? 'error' : 'skipped' };
      row.elapsedMs = Date.now() - started;
      return row;
    }
    if (qc.state === 'disabled') {
      const row = baseRow(dot, 'retry');
      row.notes = ['FMCSA API key is not configured on the server, so this DOT was not looked up.'];
      row.lookup = { fmcsa: 'disabled', census: 'skipped', insurance: 'skipped' };
      row.elapsedMs = Date.now() - started;
      return row;
    }
    const row = baseRow(dot, 'not_found');
    row.notes = ['No FMCSA record found for this USDOT number.'];
    row.missing = [...CONTACT_FIELDS];
    row.lookup = { fmcsa: 'not_found', census: 'not_found', insurance: 'skipped' };
    row.elapsedMs = Date.now() - started;
    return row;
  }

  /* Merge ----------------------------------------------------------------- */
  const legalName = carrier?.legalName ?? census?.legalName ?? null;
  const dbaName = carrier?.dbaName ?? census?.dbaName ?? null;

  const phone = normalisePhone(carrier?.phone ?? census?.phone);
  const emailResult = normaliseEmail(carrier?.email ?? census?.email);
  if (emailResult.note) notes.push(emailResult.note);

  const officer = normaliseName(carrier?.officer ?? census?.officer);
  const contactName = officer ?? legalName;

  const addDate = parseFmcsaDate(carrier?.addDate ?? census?.addDate);
  const createdEdt = formatEastern(addDate);
  const mcs150Date = parseFmcsaDate(carrier?.mcs150Date ?? census?.mcs150Date);

  const embedded = carrier ? policiesFromQc(carrier as QcCarrier & { insurance?: unknown }) : [];
  const policies = rankPolicies([...embedded, ...ctx.insurance], today);
  const primary =
    policies.find((p) => p.kind === 'bipd' && isActivePolicy(p, today)) ??
    policies.find((p) => isActivePolicy(p, today)) ??
    policies[0] ??
    null;

  if (qc.state === 'error') {
    notes.push(`Registration refresh failed (${qc.error ?? 'unknown error'}); census values shown where available.`);
  }
  if (primary && primary.kind !== 'bipd') {
    notes.push(
      `No liability (BIPD) policy is on file, so the ${primary.kindLabel.toLowerCase()} filing is shown in the policy columns.`,
    );
  }
  if (primary && !primary.effectiveDate) notes.push('FMCSA holds no effective date for this policy.');
  if (primary && !primary.cancellationDate) {
    notes.push('No expiration date on file — FMCSA only publishes one when the insurer files a cancellation.');
  }

  const sources: string[] = [];
  if (carrier) sources.push('FMCSA QCMobile');
  if (census) sources.push('FMCSA census');
  if (policies.some((p) => p.source === 'motus-insur')) sources.push('Motus Insur');
  if (policies.some((p) => p.source === 'motus-inshist')) sources.push('Motus InsHist');

  const missing: string[] = [];
  if (!contactName) missing.push('Contact name');
  if (!legalName) missing.push('Business name');
  if (!phone.display) missing.push('Phone');
  if (!emailResult.email) missing.push('Email');
  if (!createdEdt) missing.push('Created (EDT)');
  if (!primary?.policyNumber) missing.push('Policy Number');
  if (!primary?.effectiveDate) missing.push('Effective Date');
  if (!primary?.cancellationDate) missing.push('Expiration Date');

  const hasContact = Boolean(phone.display && emailResult.email);
  const hasInsurance = Boolean(primary?.policyNumber);

  let status: CarrierEnrichment['status'];
  if (ctx.insuranceFailed && !hasInsurance) {
    // Prevent incomplete MOTUS lookups (e.g. HTTP 403 rate blocks) from being
    // marked complete/partial as though the carrier genuinely had no insurance.
    status = 'retry';
    notes.unshift(
      'Waiting for MOTUS enrichment — insurance detail lookup failed or was rate-limited, so policy eligibility could not be validated.',
    );
  } else if (hasContact && hasInsurance) {
    status = 'enriched';
  } else if (legalName) {
    status = 'partial';
  } else {
    status = 'not_found';
  }

  if (status === 'partial') {
    const lacked = [
      !hasContact ? 'a usable phone or email' : null,
      !hasInsurance ? 'a policy number' : null,
    ].filter(Boolean);
    notes.unshift(`Carrier matched, but FMCSA does not publish ${lacked.join(' or ')}.`);
  }

  const row = baseRow(dot, status);
  Object.assign(row, {
    legalName,
    dbaName,
    contactName,
    phone: phone.display,
    phoneE164: phone.e164,
    email: emailResult.email,
    createdEdt,
    mcs150Date,
    street: carrier?.street ?? census?.street ?? null,
    city: carrier?.city ?? census?.city ?? null,
    state: carrier?.state ?? census?.state ?? null,
    zip: carrier?.zip ?? census?.zip ?? null,
    usdotStatus: usdotStatusLabel(
      carrier?.allowedToOperate,
      census?.statusCode ?? carrier?.statusCode,
    ),
    powerUnits: carrier?.powerUnits ?? census?.powerUnits ?? null,
    drivers: carrier?.drivers ?? census?.drivers ?? null,
    policy: primary,
    policies,
    sources,
    notes,
    missing,
    needsCorrection: emailResult.needsCorrection,
  });

  row.lookup = {
    fmcsa: qc.state,
    census: censusState,
    insurance: ctx.insuranceFailed ? 'error' : policies.length > 0 ? 'ok' : 'not_found',
  };
  row.elapsedMs = Date.now() - started;
  return row;
}

/**
 * QCMobile occasionally embeds insurance filings in the carrier payload.
 * Accept them when present so the row is complete even if Motus is unreachable.
 */
export function policiesFromQc(carrier: QcCarrier & { insurance?: unknown }): InsurancePolicy[] {
  const raw = carrier.insurance;
  if (!Array.isArray(raw)) return [];

  const out: InsurancePolicy[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const formCode = asText(record.insFormCode ?? record.formCode);
    const typeCode = asText(record.insTypeCode);
    const kind = classifyInsurance(formCode, typeCode);
    out.push({
      formCode,
      typeCode,
      kind,
      kindLabel: kindLabel(kind),
      insurer: asText(record.insuranceCompanyName ?? record.insurer),
      policyNumber: asText(record.policyNo ?? record.policyNumber),
      coverage: Number(record.maxCovAmount ?? record.coverage) || null,
      effectiveDate: parseFmcsaDate(record.effectiveDate),
      cancellationDate: parseFmcsaDate(record.canclEffectiveDate ?? record.cancellationDate),
      transactionDate: parseFmcsaDate(record.transDate),
      active: true,
      source: 'motus-insur',
    });
  }
  return out;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

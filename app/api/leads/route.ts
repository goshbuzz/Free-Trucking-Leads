import { NextResponse } from 'next/server';
import { limits, isMockMode } from '@/lib/env';
import { describeFilters, normaliseFilters, type LeadFilters } from '@/lib/leads/filters';
import { normaliseState, stateTokens } from '@/lib/leads/states';
import { searchLeads } from '@/lib/leads/search';
import { parseFmcsaDate, todayIso } from '@/lib/normalize';
import type { LeadSearchMeta, LeadSearchResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface LeadBody {
  /** Legacy single-window fields. */
  from?: unknown;
  to?: unknown;
  /** Separate Effective Date range. */
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  /** Separate Expiry Date range. */
  expiryFrom?: unknown;
  expiryTo?: unknown;
  limit?: unknown;
  includeRejected?: unknown;
  filters?: unknown;
}

const MAX_DAYS = 3 * 366;

function isoDate(value: unknown): string | null {
  return (
    parseFmcsaDate(value) ??
    (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null)
  );
}

function parseOptionalDate(value: unknown): { valid: true; date: string | null } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, date: null };
  if (typeof value === 'string' && value.trim() === '') return { valid: true, date: null };
  const parsed = isoDate(value);
  if (!parsed) return { valid: false };
  return { valid: true, date: parsed };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** 0 (or a blank) means "no limit", which the UI caps at the deployment maximum. */
function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return max;
  return Math.min(Math.floor(n), max);
}

/**
 * POST /api/leads
 * Body: {
 *   effectiveFrom?, effectiveTo?, expiryFrom?, expiryTo?,
 *   from?, to?, // legacy single-range fallback
 *   limit, includeRejected, filters
 * }
 *
 * Returns carrier leads from the FMCSA Company Census File, joined to Motus
 * insurance filings. Every value leaves the query as a normalised state code,
 * cargo id or 8-digit date string, so nothing typed by a user reaches SoQL unvalidated.
 */
export async function POST(request: Request) {
  const limit = limits();
  let body: LeadBody;

  try {
    body = (await request.json()) as LeadBody;
  } catch {
    return NextResponse.json(
      { error: 'Send a JSON body with effective/expiry date ranges and filters.' },
      { status: 400 },
    );
  }

  const hasSeparateFields =
    'effectiveFrom' in body || 'effectiveTo' in body || 'expiryFrom' in body || 'expiryTo' in body;

  let effectiveFrom: string | null = null;
  let effectiveTo: string | null = null;
  let expiryFrom: string | null = null;
  let expiryTo: string | null = null;
  let legacyFrom: string | undefined;
  let legacyTo: string | undefined;

  if (hasSeparateFields) {
    const effFromRes = parseOptionalDate(body.effectiveFrom);
    const effToRes = parseOptionalDate(body.effectiveTo);
    const expFromRes = parseOptionalDate(body.expiryFrom);
    const expToRes = parseOptionalDate(body.expiryTo);

    if (!effFromRes.valid || !effToRes.valid) {
      return NextResponse.json(
        { error: 'Effective "From" and "To" must be valid calendar dates (or left blank).' },
        { status: 422 },
      );
    }
    if (!expFromRes.valid || !expToRes.valid) {
      return NextResponse.json(
        { error: 'Expiry "From" and "To" must be valid calendar dates (or left blank).' },
        { status: 422 },
      );
    }

    effectiveFrom = effFromRes.date;
    effectiveTo = effToRes.date;
    expiryFrom = expFromRes.date;
    expiryTo = expToRes.date;

    if (!effectiveFrom && !effectiveTo && !expiryFrom && !expiryTo) {
      return NextResponse.json(
        { error: 'Choose at least an Effective Date range or an Expiry Date range.' },
        { status: 422 },
      );
    }

    if (effectiveFrom && effectiveTo) {
      if (effectiveFrom > effectiveTo) {
        return NextResponse.json(
          { error: 'The Effective "From" date is after the Effective "To" date.' },
          { status: 422 },
        );
      }
      if (daysBetween(effectiveFrom, effectiveTo) > MAX_DAYS) {
        return NextResponse.json(
          {
            error: `The Effective date range is longer than ${MAX_DAYS / 366} years. Narrow the Effective dates so the preview stays fast.`,
          },
          { status: 422 },
        );
      }
    }

    if (expiryFrom && expiryTo) {
      if (expiryFrom > expiryTo) {
        return NextResponse.json(
          { error: 'The Expiry "From" date is after the Expiry "To" date.' },
          { status: 422 },
        );
      }
      if (daysBetween(expiryFrom, expiryTo) > MAX_DAYS) {
        return NextResponse.json(
          {
            error: `The Expiry date range is longer than ${MAX_DAYS / 366} years. Narrow the Expiry dates so the preview stays fast.`,
          },
          { status: 422 },
        );
      }
    }
  } else {
    const from = isoDate(body.from);
    const to = isoDate(body.to);
    if (!from || !to) {
      return NextResponse.json(
        { error: 'Choose a "From" and "To" date. Both must be real calendar dates.' },
        { status: 422 },
      );
    }
    if (from > to) {
      return NextResponse.json({ error: 'The "From" date is after the "To" date.' }, { status: 422 });
    }
    if (daysBetween(from, to) > MAX_DAYS) {
      return NextResponse.json(
        { error: `That range is longer than ${MAX_DAYS / 366} years. Narrow the dates so the preview stays fast.` },
        { status: 422 },
      );
    }
    legacyFrom = from;
    legacyTo = to;
    effectiveFrom = from;
    effectiveTo = to;
  }

  const requested = (body.filters ?? {}) as Record<string, unknown>;
  const filters: LeadFilters = normaliseFilters(requested);
  const includeRejected = body.includeRejected === true;

  /* A typo in the state box must be reported, not silently widened to "every state". */
  for (const field of ['states', 'excludedStates'] as const) {
    const raw = requested[field];
    if (raw === undefined || raw === null) continue;
    const tokens = (Array.isArray(raw) ? raw.map(String) : [String(raw)])
      .flatMap((value) => stateTokens(value))
      .filter(Boolean);
    const unknown = tokens.filter((token) => normaliseState(token) === null);
    if (tokens.length > 0 && unknown.length === tokens.length) {
      return NextResponse.json(
        {
          error: `“${unknown.join(', ')}” is not a US state. Use a two-letter code such as TX, OK or NY, or the full state name.`,
        },
        { status: 422 },
      );
    }
  }
  const wanted = clampLimit(body.limit, 250, Math.min(limit.maxRowsPerFile, 2000));

  const included = filters.states.length > 0 ? filters.states : undefined;
  if (included && included.every((state) => filters.excludedStates.includes(state))) {
    return NextResponse.json(
      { error: 'Every state you selected is also in the excluded list — remove one of them.' },
      { status: 422 },
    );
  }
  if (filters.states.length === 0 && filters.excludedStates.length >= 51) {
    return NextResponse.json(
      { error: 'Every state is excluded — the search would never return anything.' },
      { status: 422 },
    );
  }

  try {
    const result = await searchLeads(
      hasSeparateFields
        ? {
            filters,
            effective: { from: effectiveFrom, to: effectiveTo },
            expiry: { from: expiryFrom, to: expiryTo },
            limit: wanted,
            includeRejected,
            signal: request.signal,
          }
        : {
            filters,
            from: legacyFrom,
            to: legacyTo,
            limit: wanted,
            includeRejected,
            signal: request.signal,
          },
    );

    const summaryFrom = effectiveFrom ?? expiryFrom ?? legacyFrom ?? null;
    const summaryTo = effectiveTo ?? expiryTo ?? legacyTo ?? null;

    const meta: LeadSearchMeta = {
      requested: wanted,
      returned: result.rows.length,
      from: summaryFrom,
      to: summaryTo,
      effectiveFrom: result.ranges.effective.from,
      effectiveTo: result.ranges.effective.to,
      expiryFrom: result.ranges.expiry.from,
      expiryTo: result.ranges.expiry.to,
      limit: wanted,
      includeRejected,
      candidates: result.candidates,
      filingsInRange: result.filingsInRange,
      funnel: result.funnel,
      scanned: result.scanned,
      truncated: result.truncated,
      complete: result.complete,
      unenrichedCount: result.unenrichedCount,
      elapsedMs: result.elapsedMs,
      mock: isMockMode(),
      dateMode: result.dateMode,
      warnings: result.warnings,
      description: describeFilters(filters),
    };

    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'The lead search failed.', meta }, { status: 502 });
    }

    const payload: LeadSearchResponse = {
      rows: result.rows,
      meta,
      rejected: result.rejected,
      rejectedTruncated: result.rejectedTruncated,
    };
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store', 'Server-Timing': `leads;dur=${result.elapsedMs}` },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `Lead search failed: ${message}` }, { status: 502 });
  }
}

export async function GET() {
  return NextResponse.json({
    usage:
      'POST { effectiveFrom: "yyyy-mm-dd" | null, effectiveTo: "yyyy-mm-dd" | null, expiryFrom: "yyyy-mm-dd" | null, expiryTo: "yyyy-mm-dd" | null, limit: 250, includeRejected: false, filters: {...} }',
    today: todayIso(),
    limits: limits(),
    filters: {
      states: 'optional list of US state codes to search (one state is enough)',
      excludedStates: 'states to leave out',
      insurance: 'any | yes | no',
      operation: 'any | interstate | intrastate',
      authorityStatus: 'active | any | inactive | pending',
      excludedCargo: 'cargo ids from /api/leads?help=1',
    },
  });
}

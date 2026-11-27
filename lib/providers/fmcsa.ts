/**
 * FMCSA QCMobile web service client.
 *
 * The webKey is read from the server environment on every request and never
 * leaves the server (it is not put in a response, a log line or the client
 * bundle). Field names are read defensively because QCMobile has added fields
 * over time and the payload shape differs slightly between environments.
 */

import { FMCSA_BASE_URL, resolveFmcsaKey } from '../env';
import { fetchJson } from '../http';
import type { LookupState } from '../types';

export interface QcCarrier {
  dotNumber: string;
  legalName: string | null;
  dbaName: string | null;
  email: string | null;
  phone: string | null;
  cellPhone: string | null;
  officer: string | null;
  addDate: string | null;
  mcs150Date: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  statusCode: string | null;
  allowedToOperate: string | null;
  powerUnits: number | null;
  drivers: number | null;
  /** Docket numbers advertised by the carrier record, when present. */
  dockets: string[];
}

export interface QcLookup {
  state: LookupState;
  carrier: QcCarrier | null;
  error: string | null;
}

function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** QCMobile wraps results in `content`, which is an object or an array depending on the endpoint. */
function unwrapContent(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  let content = root.content;

  if (Array.isArray(content)) content = content[0];
  if (!content || typeof content !== 'object') return null;

  const record = content as Record<string, unknown>;
  const nested = record.carrier ?? record['carriers'];
  if (Array.isArray(nested)) {
    const first = nested[0] as Record<string, unknown> | undefined;
    return first && typeof first === 'object' ? first : null;
  }
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;

  // Some deployments return the carrier object directly under content.
  if ('dotNumber' in record || 'legalName' in record) return record;
  return null;
}

export function parseQcCarrier(body: unknown, fallbackDot: string): QcCarrier | null {
  const record = unwrapContent(body);
  if (!record) return null;

  const dockets = new Set<string>();
  for (const key of ['docketNumber', 'docketNumber1', 'mcNumber', 'mcMxNumber']) {
    const value = toText(record[key]);
    if (value) dockets.add(value);
  }

  return {
    dotNumber: toText(pick(record, ['dotNumber', 'dot_number', 'usdotNumber'])) ?? fallbackDot,
    legalName: toText(pick(record, ['legalName', 'legal_name', 'name'])),
    dbaName: toText(pick(record, ['dbaName', 'dba_name'])),
    email: toText(pick(record, ['emailAddress', 'email_address', 'email'])),
    phone: toText(pick(record, ['telephone', 'phone', 'phyPhone'])),
    cellPhone: toText(pick(record, ['cellPhone', 'cell_phone', 'cellphone'])),
    officer: toText(pick(record, ['companyOfficer1', 'companyOfficer_1', 'companyOfficer', 'officer1'])),
    addDate: toText(pick(record, ['addDate', 'addedDate', 'add_date'])),
    mcs150Date: toText(pick(record, ['mcs150Date', 'mcs150_date'])),
    street: toText(pick(record, ['phyStreet', 'phy_street', 'physicalStreet'])),
    city: toText(pick(record, ['phyCity', 'phy_city'])),
    state: toText(pick(record, ['phyState', 'phy_state'])),
    zip: toText(pick(record, ['phyZipcode', 'phy_zip', 'phyZip'])),
    statusCode: toText(pick(record, ['statusCode', 'status_code'])),
    allowedToOperate: toText(pick(record, ['allowedToOperate', 'allowed_to_operate'])),
    powerUnits: toNumber(pick(record, ['totalPowerUnits', 'powerUnits', 'power_units'])),
    drivers: toNumber(pick(record, ['totalDrivers', 'drivers', 'total_drivers'])),
    dockets: [...dockets],
  };
}

export function isFmcsaConfigured(): boolean {
  return resolveFmcsaKey() !== null;
}

/** Look up one carrier by USDOT number. */
export async function fetchQcCarrier(dot: string, signal?: AbortSignal): Promise<QcLookup> {
  const resolved = resolveFmcsaKey();
  if (!resolved) {
    return { state: 'disabled', carrier: null, error: 'FMCSA webKey is not configured' };
  }

  const url = `${FMCSA_BASE_URL}/carriers/${encodeURIComponent(dot)}?webKey=${encodeURIComponent(resolved.key)}`;
  const result = await fetchJson<unknown>(url, { signal, timeoutMs: 12_000, retries: 2 });

  if (!result.ok) {
    // A 404 from QCMobile means "no such carrier", not "the API is broken".
    if (result.status === 404) {
      return { state: 'not_found', carrier: null, error: null };
    }
    return { state: 'error', carrier: null, error: result.error };
  }

  const carrier = parseQcCarrier(result.data, dot);
  if (!carrier) {
    return { state: 'not_found', carrier: null, error: null };
  }
  return { state: 'ok', carrier, error: null };
}

/** Cheap credential check used by the status endpoint. */
export async function probeFmcsa(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const resolved = resolveFmcsaKey();
  if (!resolved) {
    return { ok: false, latencyMs: 0, message: 'No FMCSA webKey found in the environment' };
  }

  const url = `${FMCSA_BASE_URL}/carriers/${encodeURIComponent(
    process.env.FMCSA_PROBE_DOT ?? '1515240',
  )}?webKey=${encodeURIComponent(resolved.key)}`;
  const result = await fetchJson<unknown>(url, { signal, timeoutMs: 10_000, retries: 0 });

  if (result.ok && parseQcCarrier(result.data, '0')) {
    return { ok: true, latencyMs: result.latencyMs, message: 'Live carrier response received' };
  }
  if (result.ok) {
    return { ok: false, latencyMs: result.latencyMs, message: 'Key accepted but no carrier data returned' };
  }
  if (result.status === 404) {
    return { ok: false, latencyMs: result.latencyMs, message: 'Key accepted, probe DOT not found' };
  }
  return { ok: false, latencyMs: result.latencyMs, message: result.error ?? 'Unknown error' };
}

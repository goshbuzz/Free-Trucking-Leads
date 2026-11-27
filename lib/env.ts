/**
 * Environment resolution.
 *
 * Vercel env var names are chosen by whoever creates the project, so the FMCSA
 * webKey is looked up under every common spelling. The name that matched is
 * reported in the UI (never the key itself) so it is obvious which variable is
 * live.
 */

export const FMCSA_KEY_ENV_CANDIDATES = [
  'FMCSA_WEB_KEY',
  'FMCSA_WEBKEY',
  'FMCSA_API_KEY',
  'FMCSA_KEY',
  'FMCSA_WEBKEY_QCMOBILE',
  'QCMOBILE_WEB_KEY',
  'QCMOBILE_WEBKEY',
  'WEBKEY',
] as const;

export const MOTUS_TOKEN_ENV_CANDIDATES = ['SOCRATA_APP_TOKEN', 'MOTUS_APP_TOKEN', 'FMCSA_APP_TOKEN'] as const;

export interface ResolvedKey {
  key: string;
  envVar: string;
}

function readFirst(names: readonly string[]): ResolvedKey | null {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return { key: value.trim(), envVar: name };
    }
  }
  return null;
}

export function resolveFmcsaKey(): ResolvedKey | null {
  return readFirst(FMCSA_KEY_ENV_CANDIDATES);
}

export function resolveMotusToken(): ResolvedKey | null {
  return readFirst(MOTUS_TOKEN_ENV_CANDIDATES);
}

export const FMCSA_BASE_URL = (process.env.FMCSA_BASE_URL ?? 'https://mobile.fmcsa.dot.gov/qc/services').replace(
  /\/+$/,
  '',
);

export const MOTUS_BASE_URL = (process.env.MOTUS_BASE_URL ?? 'https://data.transportation.gov/resource').replace(
  /\/+$/,
  '',
);

/** Motus (formerly L&I) licence & insurance datasets published on data.transportation.gov. */
export const MOTUS_DATASETS = {
  /** Company Census File — the only public file that carries email + phone for every registrant. */
  census: process.env.MOTUS_CENSUS_DATASET ?? 'az4n-8mr2',
  /** Motus Insur, All With History — active and pending insurance filings. */
  insurance: process.env.MOTUS_INSURANCE_DATASET ?? 'c5y8-a4uz',
  /** Motus InsHist, All With History — terminated / replaced policies with cancellation dates. */
  insuranceHistory: process.env.MOTUS_INSURANCE_HISTORY_DATASET ?? '3uet-3z4i',
} as const;

export function isMotusEnabled(): boolean {
  return process.env.MOTUS_ENABLED !== '0' && process.env.MOTUS_ENABLED !== 'false';
}

/** Fixture mode for local demos and screenshots. Never on unless explicitly set. */
export function isMockMode(): boolean {
  return process.env.MOCK_FMCSA === '1' || process.env.MOCK_FMCSA === 'true';
}

export function limits() {
  const maxRows = Number(process.env.MAX_ROWS_PER_FILE ?? 5000);
  const maxBytes = Number(process.env.MAX_FILE_BYTES ?? 2 * 1024 * 1024);
  const dotsPerRequest = Number(process.env.DOTS_PER_REQUEST ?? 250);
  return {
    maxRowsPerFile: Number.isFinite(maxRows) && maxRows > 0 ? maxRows : 5000,
    maxFileBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 2 * 1024 * 1024,
    dotsPerRequest: Number.isFinite(dotsPerRequest) && dotsPerRequest > 0 ? dotsPerRequest : 250,
  };
}

/** Show the tail of a secret so the operator can confirm which key is deployed. */
export function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}

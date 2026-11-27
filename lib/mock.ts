/**
 * Deterministic demo data for local previews and screenshots.
 *
 * Enabled only when MOCK_FMCSA=1. It deliberately reproduces the messiness of
 * real FMCSA data — missing emails, bare-domain "emails", carrier records with
 * no insurance filing, and DOT numbers that do not exist — so the UI can be
 * checked against the cases that actually break exports.
 */

import type { InsurancePolicy } from './types';
import type { QcCarrier } from './providers/fmcsa';

const COMPANIES = [
  ['HORIZON FREIGHT LINES LLC', 'HORIZON LOGISTICS'],
  ['CEDAR RIDGE TRUCKING INC', null],
  ['BLUE OAK TRANSPORT LLC', 'BLUE OAK HAULING'],
  ['IRONHORSE CARRIER GROUP', null],
  ['SUMMIT HAULERS CO', 'SUMMIT EXPRESS'],
  ['PRAIRIE WIND TRANSPORT', null],
  ['NORTHSTAR DRAYAGE LLC', 'NORTHSTAR PORT SERVICES'],
  ['VALLEY LINE TRUCKING', null],
] as const;

const CITIES: Array<[string, string, string]> = [
  ['DALLAS', 'TX', '75212'],
  ['MEMPHIS', 'TN', '38118'],
  ['COLUMBUS', 'OH', '43207'],
  ['FONTANA', 'CA', '92337'],
  ['ATLANTA', 'GA', '30336'],
  ['JOLIET', 'IL', '60436'],
  ['LAREDO', 'TX', '78045'],
  ['HARRISBURG', 'PA', '17109'],
];

const FIRST = ['MARCUS', 'ANGELA', 'DEMETRIUS', 'LORRAINE', 'RAFAEL', 'TASHA', 'WAYNE', 'GLORIA'];
const LAST = ['HOLLOWAY', 'BAPTISTE', 'ORTIZ', 'MCCALLISTER', 'WEAVER', 'OKONKWO', 'DELACRUZ', 'BRANTLEY'];

const INSURERS = [
  'Old Republic Insurance Company',
  'Great West Casualty Company',
  'Motor Transport Mutual Risk Retention Group, Inc.',
  'Liberty Mutual Insurance Company',
];

function hash(dot: string): number {
  let h = 2166136261;
  for (let i = 0; i < dot.length; i += 1) {
    h ^= dot.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pick<T>(list: readonly T[], seed: number, salt = 0): T {
  return list[(seed + salt * 7919) % list.length];
}

/** Fill one synthetic carrier record for a DOT number. */
function synthesise(dot: string): QcCarrier | null {
  const seed = hash(dot);
  // One DOT in 17 is reported as "no record found" — mirrors real uploads.
  if (seed % 17 === 0) return null;

  const [legalName, dbaName] = pick(COMPANIES, seed);
  const [city, state, zip] = pick(CITIES, seed, 1);
  const area = 200 + (seed % 700);
  const prefix = 200 + (seed % 700);
  const line = String(seed % 10000).padStart(4, '0');
  const emailStyle = seed % 23;
  const domain = legalName.split(' ')[0].toLowerCase();
  const email =
    emailStyle === 0
      ? `${domain}.com` // bare domain, the classic bad row
      : emailStyle === 1
        ? null // no email filed
        : emailStyle === 2
          ? null
          : `dispatch@${domain}trucking.com`;

  const year = 2005 + (seed % 20);
  const month = String((seed % 12) + 1).padStart(2, '0');
  const day = String((seed % 27) + 1).padStart(2, '0');

  return {
    dotNumber: dot,
    legalName,
    dbaName,
    email,
    phone: `${area}${prefix}${line}`,
    cellPhone: null,
    officer: `${pick(FIRST, seed, 2)} ${pick(LAST, seed, 3)}`,
    addDate: `${year}${month}${day}`,
    mcs150Date: `${2019 + (seed % 7)}${month}${day}`,
    street: `${100 + (seed % 8900)} ${pick(['INDUSTRIAL PKWY', 'COMMERCE DR', 'WAREHOUSE ROW', 'LOGISTICS WAY'], seed, 4)}`,
    city,
    state,
    zip,
    statusCode: seed % 5 === 0 ? 'I' : 'A',
    allowedToOperate: seed % 5 === 0 ? 'N' : 'Y',
    powerUnits: 1 + (seed % 40),
    drivers: 1 + (seed % 55),
    dockets: [`MC${(seed % 900000) + 100000}`],
  };
}

export function mockCarrierFor(dot: string): QcCarrier | null {
  return synthesise(dot);
}

export function mockPoliciesFor(dot: string): InsurancePolicy[] {
  const seed = hash(dot);
  const carrier = synthesise(dot);
  if (!carrier) return [];

  // Some carriers have no insurance on file at all.
  if (seed % 6 === 0) return [];

  const policyNumber = `${String.fromCharCode(65 + (seed % 26))}${String.fromCharCode(
    65 + (seed % 19),
  )}${(seed % 9_000_000) + 1_000_000}`;
  const insurer = pick(INSURERS, seed, 5);
  const effectiveYear = 2023 + (seed % 3);
  const effective = `${effectiveYear}-${String((seed % 12) + 1).padStart(2, '0')}-01`;

  const policies: InsurancePolicy[] = [
    {
      formCode: 'BMC-91X',
      typeCode: '1',
      kind: 'bipd',
      kindLabel: 'BIPD',
      insurer,
      policyNumber,
      coverage: 1_000_000,
      effectiveDate: effective,
      // Only a third of filings carry a filed cancellation date.
      cancellationDate: seed % 3 === 0 ? `${effectiveYear + 1}-${String((seed % 12) + 1).padStart(2, '0')}-01` : null,
      transactionDate: effective,
      active: true,
      source: 'motus-insur',
    },
  ];

  if (seed % 4 === 0) {
    policies.push({
      formCode: 'BMC-34',
      typeCode: '2',
      kind: 'cargo',
      kindLabel: 'Cargo',
      insurer,
      policyNumber: `${policyNumber}-C`,
      coverage: 100_000,
      effectiveDate: effective,
      cancellationDate: null,
      transactionDate: effective,
      active: true,
      source: 'motus-insur',
    });
  }

  return policies;
}

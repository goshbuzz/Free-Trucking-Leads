/**
 * US state handling for lead filters.
 *
 * Filters are typed by hand ("TX", "tx, OK", "Texas; Oklahoma"), so parsing has
 * to be forgiving while still rejecting junk before it reaches a SoQL string.
 * Only the 50 states + DC are accepted: FMCSA physical state is a US postal
 * code, and a territory code in a filter would silently return nothing.
 */

export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

const BY_CODE = new Map(US_STATES.map((state) => [state.code, state]));
const BY_NAME = new Map(US_STATES.map((state) => [state.name.toLowerCase(), state]));

/** Turn one typed token into a state code, or null when it is not a US state. */
export function normaliseState(input: string): string | null {
  const text = String(input ?? '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const upper = text.toUpperCase();
  if (BY_CODE.has(upper)) return upper;

  const byName = BY_NAME.get(text.toLowerCase());
  return byName ? byName.code : null;
}

/**
 * Parse a free-text state list ("TX", "tx, OK", "Texas; New Mexico").
 * Unknown tokens are dropped rather than throwing, so a half-typed value never
 * blanks the whole filter.
 */
export function parseStateList(input: string): string[] {
  const codes = new Set<string>();
  for (const token of stateTokens(input)) {
    if (!token) continue;
    const code = normaliseState(token);
    if (code) codes.add(code);
  }
  return [...codes].sort();
}

/** State codes that were typed but not recognised — used for inline warnings. */
export function unrecognisedStates(input: string): string[] {
  return stateTokens(input).filter((token) => normaliseState(token) === null);
}

/**
 * Split a typed state list into candidate tokens.
 *
 * Values are separated by comma, semicolon, pipe or slash. Whitespace alone is
 * also a separator, except inside a multi-word state name ("New Mexico"), which
 * would otherwise be read as two unknown tokens.
 */
export function stateTokens(input: string): string[] {
  const chunks = String(input ?? '')
    .split(/[,;|/]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (normaliseState(chunk) !== null) {
      tokens.push(chunk);
      continue;
    }
    const words = chunk.split(/\s+/).filter(Boolean);
    if (words.length > 1 && normaliseState(words.join(' ')) !== null) {
      tokens.push(words.join(' '));
      continue;
    }
    tokens.push(...words);
  }
  return tokens;
}

export function stateName(code: string): string | null {
  return BY_CODE.get(String(code ?? '').toUpperCase())?.name ?? null;
}

/** "TX" for one state, "TX + 4 more" for several — used in summaries. */
export function summariseStates(codes: readonly string[]): string {
  if (codes.length === 0) return 'All states';
  if (codes.length === 1) return codes[0];
  return `${codes[0]} + ${codes.length - 1} more`;
}

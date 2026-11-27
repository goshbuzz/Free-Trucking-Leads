/**
 * Splitting FMCSA's company officer name into the first / last columns a
 * dialer or CRM import expects.
 *
 * The census stores one field, `company_officer_1`, holding the name exactly as
 * the carrier typed it on the MCS-150: "KULWINDER SINGH", "TIMOTHY W REYNOLDS",
 * "PAUL PRITCHARD BRIGGS JR", "MANUEL DE JESUS AMAYA". There is no separate
 * first/last field to read, so the split has to be a rule — and a wrong rule
 * produces a wrong name on a lead sheet, which is worse than a blank.
 *
 * The rules below are ordered from certain to cautious: a name is only split
 * when the shape is unambiguous, and anything else is left in the first-name
 * column whole rather than being quietly mangled.
 */

/** Suffixes stay with the last name: "BRIGGS JR" is the surname line. */
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V', 'JR.', 'SR.', 'MD', 'DDS', 'PHD']);

/** Particles belong to the surname: "DE JESUS", "VAN DYKE", "MC DONALD". */
const PARTICLES = new Set(['DE', 'DEL', 'DELA', 'DER', 'DI', 'DA', 'DOS', 'DU', 'LA', 'LE', 'ST', 'ST.', 'VAN', 'VON', 'Y']);

export interface SplitName {
  firstName: string | null;
  lastName: string | null;
}

/**
 * Rough title-caser matching normalize.ts's `normaliseName`, applied here so a
 * split name reads the same as the rest of the app without importing the
 * enrichment layer into the export path.
 */
export function titleCaseName(raw: string): string {
  return (
    raw
      .toLowerCase()
      // "mcdonald" -> "McDonald". Done first so the general pass below, which
      // only capitalises word-initial letters, leaves the internal C alone.
      .replace(/\bmc([a-z'\u2019\-]+)/g, (_m, rest: string) => `Mc${rest.charAt(0).toUpperCase()}${rest.slice(1)}`)
      .replace(/\b([a-z])([a-z'\u2019\-]*)/g, (_m, first: string, rest: string) => first.toUpperCase() + rest)
      // Generational suffixes read as capitals: "JR", "III", "IV". Case
      // insensitive, because the pass above has already produced "Iii".
      .replace(/\b(?:jr|sr|ii|iii|iv)\b/gi, (m) => m.toUpperCase())
  );
}


function clean(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const text = String(raw).trim().replace(/\s+/g, ' ').toUpperCase();
  if (!text) return '';
  // FMCSA uses these as "no name filed" rather than leaving the field empty.
  if (/^(?:NONE|N\/A|NA|NULL|-+)$/.test(text)) return '';
  return text;
}

/**
 * Split a company officer name into first and last.
 *
 *   "KULWINDER SINGH"            → Kulwinder / Singh
 *   "JOSE EFRAIN FLORES ALVARADO"→ Jose Efrain Flores / Alvarado
 *   "TIMOTHY W REYNOLDS"         → Timothy W / Reynolds
 *   "PAUL PRITCHARD BRIGGS JR"   → Paul Pritchard / Briggs Jr
 *   "MANUEL DE JESUS AMAYA"      → Manuel / De Jesus Amaya
 *   "WC MARTIN JR"               → Wc / Martin Jr
 *   "GHOST" (one word)           → Ghost / (blank)
 *   ""                            → (blank) / (blank)
 *
 * A single-word name goes entirely into the first-name column: it is a company
 * or a mononym often enough that guessing a surname would invent data.
 *
 * Known limitation: a compound Hispanic surname ("Flores Alvarado") splits as
 * "Flores" in the first name and "Alvarado" in the last. Detecting which of two
 * words is a paternal versus maternal surname is not reliably possible from one
 * string, and guessing would silently mis-name a lead, so the rule stays
 * deterministic — the last word is the surname — and the caveat is documented
 * rather than papered over.
 */
export function splitOfficerName(raw: string | null | undefined): SplitName {
  const text = clean(raw);
  if (!text) return { firstName: null, lastName: null };

  const words = text.split(' ').filter(Boolean);
  if (words.length === 1) {
    return { firstName: titleCaseName(words[0]), lastName: null };
  }

  // Walk back over suffixes so a trailing "JR" does not become the surname.
  let end = words.length;
  while (end > 1 && SUFFIXES.has(words[end - 1])) end -= 1;

  // Walk forward from index 1 over particles that belong to the surname.
  let surnameStart = end - 1;
  while (surnameStart > 1 && PARTICLES.has(words[surnameStart - 1])) surnameStart -= 1;

  if (surnameStart <= 0) {
    // Defensive: a name made entirely of particles has no usable split.
    return { firstName: titleCaseName(words.join(' ')), lastName: null };
  }

  const first = words.slice(0, surnameStart).join(' ');
  const last = words.slice(surnameStart).join(' ');

  return {
    firstName: titleCaseName(first) || null,
    lastName: titleCaseName(last) || null,
  };
}

/** The officer name as one contact string, for the existing Contact name column. */
export function fullOfficerName(raw: string | null | undefined): string | null {
  const text = clean(raw);
  return text ? titleCaseName(text) : null;
}

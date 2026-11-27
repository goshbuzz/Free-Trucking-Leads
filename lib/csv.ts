/**
 * A small, dependency-free RFC 4180 CSV reader.
 *
 * Uploaded lists come from Excel, Google Sheets, factoring portals and CRMs, so
 * the reader tolerates BOMs, CRLF endings, quoted fields with embedded commas
 * and newlines, escaped quotes, and semicolon/tab separated exports.
 */

export interface ParsedCsv {
  /** Column names, always present (generated when the file has no header). */
  headers: string[];
  /** Raw cell values, row-major. Ragged rows are padded with ''. */
  rows: string[][];
  delimiter: string;
  /** True when the first row was consumed as a header. */
  hasHeaderRow: boolean;
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

export function detectDelimiter(sample: string): string {
  let best = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const counts = countFieldsPerLine(sample, delimiter);
    if (counts.length === 0) continue;
    const first = counts[0];
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = first > 1 ? consistent * 100 + first : 0;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function countFieldsPerLine(sample: string, delimiter: string): number[] {
  const rows = splitRows(sample, delimiter);
  return rows.filter((r) => r.length > 1).map((r) => r.length);
}

/** Split a CSV document into rows of cells. */
export function splitRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Drop the phantom empty row produced by a trailing newline.
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === delimiter) {
      pushField();
      i += 1;
      continue;
    }

    if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }

    if (char === '\n') {
      pushRow();
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) pushRow();

  return rows;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const firstLineEnd = text.search(/\r?\n/);
  const sample = text.slice(0, firstLineEnd === -1 ? text.length : firstLineEnd);
  const delimiter = detectDelimiter(sample);

  let rows = splitRows(text, delimiter);
  if (rows.length === 0) {
    return { headers: [], rows: [], delimiter, hasHeaderRow: false };
  }

  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  rows = rows.map((r) => {
    const padded = r.slice(0, width);
    while (padded.length < width) padded.push('');
    return padded.map((cell) => cell.trim());
  });

  const headerCandidate = rows[0];
  const looksLikeHeader =
    headerCandidate.some((cell) => cell.length > 0 && !/^[\d\s.,#-]+$/.test(cell)) &&
    headerCandidate.some((cell) => /dot|usdot|docket|carrier|company|mc\b|num/i.test(cell));

  if (!looksLikeHeader) {
    const headers = width > 1 ? headerCandidate.map((h, idx) => h || `Column ${idx + 1}`) : ['DOT Number'];
    return {
      headers,
      rows: width > 1 ? rows.slice(1) : rows,
      delimiter,
      hasHeaderRow: width > 1,
    };
  }

  return {
    headers: headerCandidate.map((h, idx) => h || `Column ${idx + 1}`),
    rows: rows.slice(1),
    delimiter,
    hasHeaderRow: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Header matching                                                            */
/* -------------------------------------------------------------------------- */

/** Header spellings we accept, most authoritative first. */
const DOT_HEADER_ALIASES = [
  'usdot number',
  'usdot',
  'us dot',
  'us dot number',
  'dot number',
  'dot #',
  'dot no',
  'dot no.',
  'dotnum',
  'dot',
  'usdotnum',
  'usdotnumber',
  'dot_number',
  'usdot_number',
  'usdotnumber',
  'usdot #',
];

/** Columns that contain a number but are NOT the USDOT number. */
const NOT_DOT_HEADERS = [/docket/i, /^mc\b/i, /^mc\s/i, /mx\b/i, /ff\b/i, /^id$/i, /^row/i, /serial/i];

function canonicalHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[_\-.#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the column holding USDOT numbers.
 *
 * Priority: an exact "DOT"/"USDOT" style header, then any header containing
 * "dot", then a lone numeric column. MC/docket-only files return null so the API
 * can explain the problem instead of querying the wrong number.
 */
export function findDotColumn(headers: string[], rows: string[][]): number | null {
  const canonical = headers.map(canonicalHeader);

  for (const alias of DOT_HEADER_ALIASES) {
    const index = canonical.indexOf(alias);
    if (index !== -1) return index;
  }

  for (let i = 0; i < canonical.length; i += 1) {
    const header = canonical[i];
    if (!header) continue;
    if (NOT_DOT_HEADERS.some((re) => re.test(header))) continue;
    if (/\bdot\b|\busdot\b/.test(header)) return i;
  }

  // Fall back to a column whose values are all plausible DOT numbers.
  for (let col = 0; col < headers.length; col += 1) {
    const values = rows.map((r) => r[col]).filter((v) => v !== undefined && v !== '');
    if (values.length === 0) continue;
    const numeric = values.filter((v) => /^\d{1,8}(\.0+)?$/.test(v.trim()));
    if (numeric.length / values.length >= 0.9) return col;
  }

  return null;
}

export function hasDocketColumn(headers: string[]): boolean {
  return headers.some((h) => /^(?:mc|mx|ff)?\s*(?:docket|mc)\b/i.test(canonicalHeader(h)) || /docket/i.test(h));
}

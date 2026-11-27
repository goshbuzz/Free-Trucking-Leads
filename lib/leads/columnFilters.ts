/**
 * Per-column table filters, in the shape a spreadsheet uses them.
 *
 * The point of these is speed of thought: once leads are on screen, the desk
 * wants to narrow *what is already here* — "only TX", "only Progressive", "only
 * rows with a phone" — without paying for another FMCSA round trip. They are
 * therefore applied client-side to the rows in hand and never sent to the API.
 *
 * Every rule is one of a small set of plain operations rather than a free-text
 * query language, because a mistyped filter that silently matches nothing looks
 * identical to "there are no such carriers".
 */

import type { LeadRow } from '../types';

export type FilterOp =
  /** Text contains the value, case-insensitive. */
  | 'contains'
  | 'equals'
  | 'notEquals'
  /** Value is one of the ticked values (spreadsheet checkbox list). */
  | 'in'
  | 'notIn'
  | 'empty'
  | 'notEmpty'
  /** Numeric / date comparison; dates compare as ISO strings. */
  | 'gte'
  | 'lte'
  | 'between';

export interface ColumnFilter {
  columnKey: string;
  op: FilterOp;
  /** Free-text operand for contains / equals / notEquals / gte / lte. */
  value?: string;
  /** Second operand for `between`. */
  value2?: string;
  /** Ticked values for `in` / `notIn`. */
  values?: string[];
}

export const FILTER_OPS: { op: FilterOp; label: string; needsValue: boolean; needsValues?: boolean }[] = [
  { op: 'contains', label: 'Contains', needsValue: true },
  { op: 'equals', label: 'Is exactly', needsValue: true },
  { op: 'notEquals', label: 'Is not', needsValue: true },
  { op: 'in', label: 'Is any of', needsValue: false, needsValues: true },
  { op: 'notIn', label: 'Is none of', needsValue: false, needsValues: true },
  { op: 'empty', label: 'Is blank', needsValue: false },
  { op: 'notEmpty', label: 'Is not blank', needsValue: false },
  { op: 'gte', label: 'Is on or after', needsValue: true },
  { op: 'lte', label: 'Is on or before', needsValue: true },
  { op: 'between', label: 'Is between', needsValue: true },
];

/** Ops that only make sense against a date, offered by the UI for date columns. */
export const DATE_OPS: FilterOp[] = ['equals', 'gte', 'lte', 'between', 'empty', 'notEmpty'];

const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** The cell text as the table shows it, which is what a user filters against. */
function cellText(row: LeadRow, columnKey: string): string {
  const raw = (row as unknown as Record<string, unknown>)[columnKey];
  if (raw === null || raw === undefined) return '';
  if (Array.isArray(raw)) return raw.join('; ');
  return String(raw);
}

/** A blank cell matches no positive value test, matching spreadsheet behaviour. */
function isBlank(value: string): boolean {
  return value.trim() === '';
}

export function matchesFilter(row: LeadRow, filter: ColumnFilter): boolean {
  const cell = cellText(row, filter.columnKey);
  const value = norm(filter.value);
  const value2 = norm(filter.value2);

  switch (filter.op) {
    case 'empty':
      return isBlank(cell);
    case 'notEmpty':
      return !isBlank(cell);
    case 'contains':
      if (!value) return true; // an empty operand must not hide every row
      return norm(cell).includes(value);
    case 'equals':
      if (!value) return true;
      return norm(cell) === value;
    case 'notEquals':
      if (!value) return true;
      return norm(cell) !== value;
    case 'in':
      if (!filter.values || filter.values.length === 0) return true;
      return filter.values.some((candidate) => norm(candidate) === norm(cell));
    case 'notIn':
      if (!filter.values || filter.values.length === 0) return true;
      return !filter.values.some((candidate) => norm(candidate) === norm(cell));
    case 'gte':
      return compare(cell, filter.value) >= 0;
    case 'lte':
      return compare(cell, filter.value) <= 0;
    case 'between': {
      if (isBlank(cell)) return false;
      return compare(cell, filter.value) >= 0 && compare(cell, filter.value2) <= 0;
    }
    default:
      return true;
  }
}

/**
 * Compare two cell values by meaning rather than by string order, so a numeric
 * or date column sorts and filters the way a person reads it.
 */
function compare(left: string, right: string | undefined): number {
  if (isBlank(left) || right === undefined || isBlank(right)) {
    // A blank never satisfies a range test.
    return isBlank(left) ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  const a = left.trim();
  const b = right.trim();

  const numericA = Number(a.replace(/[^0-9.\-]/g, ''));
  const numericB = Number(b.replace(/[^0-9.\-]/g, ''));
  const bothNumeric = !Number.isNaN(numericA) && !Number.isNaN(numericB) && /\d/.test(a) && /\d/.test(b);

  // A pure number (or a formatted amount like "1,000,000") compares numerically.
  if (bothNumeric && /^[\s$0-9,.+-]+$/.test(a) && /^[\s$0-9,.+-]+$/.test(b)) {
    return numericA - numericB;
  }

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Apply every active filter. Rows must pass all of them (AND), as in Sheets. */
export function applyColumnFilters(rows: readonly LeadRow[], filters: readonly ColumnFilter[]): LeadRow[] {
  if (filters.length === 0) return [...rows];
  return rows.filter((row) => filters.every((filter) => matchesFilter(row, filter)));
}

/**
 * Distinct values in a column, most frequent first, for the checkbox list.
 *
 * A spreadsheet shows the values that exist rather than asking the user to type
 * them, which is what makes "is any of" quick. Blanks are reported separately
 * so "is blank" stays a one-click action instead of a list entry.
 */
export function columnValues(
  rows: readonly LeadRow[],
  columnKey: string,
  limit = 60,
): { values: { value: string; count: number }[]; blankCount: number; truncated: boolean } {
  const counts = new Map<string, { value: string; count: number }>();
  let blankCount = 0;

  for (const row of rows) {
    const cell = cellText(row, columnKey).trim();
    if (isBlank(cell)) {
      blankCount += 1;
      continue;
    }
    const key = cell.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value: cell, count: 1 });
  }

  const all = [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { values: all.slice(0, limit), blankCount, truncated: all.length > limit };
}

/** Human-readable rule, used for the chip row so an active filter is auditable. */
export function describeFilter(filter: ColumnFilter, header: string): string {
  const op = FILTER_OPS.find((entry) => entry.op === filter.op)?.label ?? filter.op;
  switch (filter.op) {
    case 'empty':
    case 'notEmpty':
      return `${header} ${op.toLowerCase()}`;
    case 'in':
    case 'notIn':
      return `${header} ${op.toLowerCase()} ${filter.values?.length ?? 0} value${(filter.values?.length ?? 0) === 1 ? '' : 's'}`;
    case 'between':
      return `${header} ${op.toLowerCase()} ${filter.value || '…'} and ${filter.value2 || '…'}`;
    default:
      return `${header} ${op.toLowerCase()} “${filter.value ?? ''}”`;
  }
}

/** True when a filter has nothing to act on yet, so it should not be applied. */
export function isFilterIncomplete(filter: ColumnFilter): boolean {
  switch (filter.op) {
    case 'empty':
    case 'notEmpty':
      return false;
    case 'in':
    case 'notIn':
      return !filter.values || filter.values.length === 0;
    case 'between':
      return !filter.value && !filter.value2;
    default:
      return !filter.value || filter.value.trim() === '';
  }
}

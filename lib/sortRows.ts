/**
 * Column sorting for the review table.
 *
 * Rules that matter for an enrichment list:
 *  - blanks always sink to the bottom, in both directions, so sorting by Policy
 *    Number never buries the 200 rows that actually have a policy under the
 *    rows that do not;
 *  - numbers compare numerically (DOT 999 < DOT 1000), text compares with
 *    numeric awareness ("Policy 2" before "Policy 10");
 *  - sorting is stable, so equal values keep the upload order.
 */

import { ALL_COLUMNS, type ExportColumn } from './export';
import type { CarrierEnrichment } from './types';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function columnForKey(key: string): ExportColumn | undefined {
  return ALL_COLUMNS.find((column) => column.key === key);
}

/** Raw, comparable value for one cell. */
export function sortValueFor(row: CarrierEnrichment, key: string): string | number | null {
  const column = columnForKey(key);
  if (!column) return null;
  const value = (column.sortValue ?? column.value)(row);
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function isEmpty(value: string | number | null): boolean {
  return value === null || value === '';
}

/** Compare two non-empty values. */
export function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * Return a new array sorted by `state`. A null state restores upload order.
 * Blanks always sort last, regardless of direction.
 */
export function sortRows(
  rows: readonly CarrierEnrichment[],
  state: SortState | null,
): CarrierEnrichment[] {
  const copy = [...rows];
  if (!state) return copy;

  const direction = state.direction === 'asc' ? 1 : -1;

  return copy
    .map((row, index) => ({ row, index, value: sortValueFor(row, state.key) }))
    .sort((left, right) => {
      const aEmpty = isEmpty(left.value);
      const bEmpty = isEmpty(right.value);

      // Blanks last in both directions.
      if (aEmpty && bEmpty) return left.index - right.index;
      if (aEmpty) return 1;
      if (bEmpty) return -1;

      const result = compareValues(left.value as string | number, right.value as string | number);
      if (result !== 0) return result * direction;

      // Stable tie-break: keep the order the file arrived in.
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

/**
 * Three-state cycle used by clickable headers:
 *   unsorted → ascending → descending → unsorted (back to upload order).
 */
export function nextSortState(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return null;
}

export function ariaSortFor(current: SortState | null, key: string): 'ascending' | 'descending' | 'none' {
  if (!current || current.key !== key) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}

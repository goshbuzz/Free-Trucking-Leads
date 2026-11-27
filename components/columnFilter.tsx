'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FilterIcon, CheckIcon } from './icons';
import {
  DATE_OPS,
  FILTER_OPS,
  columnValues,
  isFilterIncomplete,
  type ColumnFilter,
  type FilterOp,
} from '@/lib/leads/columnFilters';
import type { LeadRow } from '@/lib/types';

/** Columns whose values are dates, so the UI offers date-shaped operators. */
export function isDateColumn(key: string): boolean {
  return key === 'effective1' || key === 'expiring1' || key === 'add_date' || key === 'mcs150';
}

/**
 * The filter button that sits in a table heading, and the panel it opens.
 *
 * Mirrors a spreadsheet: pick a column, pick an operation, type a value or tick
 * values that actually exist in the data. The panel is portalled nowhere — it
 * anchors under the button and closes on outside click, Escape, or selection.
 */
export function ColumnFilterButton({
  columnKey,
  header,
  rows,
  filter,
  onChange,
  onClear,
}: {
  columnKey: string;
  header: string;
  rows: readonly LeadRow[];
  filter: ColumnFilter | undefined;
  onChange: (filter: ColumnFilter) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<FilterOp>(filter?.op ?? 'contains');
  const [value, setValue] = useState(filter?.value ?? '');
  const [value2, setValue2] = useState(filter?.value2 ?? '');
  const [ticked, setTicked] = useState<string[]>(filter?.values ?? []);
  const wrapper = useRef<HTMLDivElement | null>(null);

  const active = Boolean(filter && !isFilterIncomplete(filter));
  const dateColumn = isDateColumn(columnKey);

  // Re-sync when the filter is cleared from elsewhere (e.g. "Clear all").
  useEffect(() => {
    if (!filter) {
      setOp('contains');
      setValue('');
      setValue2('');
      setTicked([]);
    }
  }, [filter]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const ops = useMemo(
    () => (dateColumn ? FILTER_OPS.filter((entry) => DATE_OPS.includes(entry.op)) : FILTER_OPS),
    [dateColumn],
  );

  const choices = useMemo(() => columnValues(rows, columnKey, 100), [rows, columnKey]);
  const needsValues = op === 'in' || op === 'notIn';
  const needsValue = op !== 'empty' && op !== 'notEmpty' && !needsValues;

  const apply = () => {
    const next: ColumnFilter = { columnKey, op };
    if (needsValues) next.values = ticked;
    if (needsValue) next.value = value;
    if (op === 'between') next.value2 = value2;

    if (isFilterIncomplete(next)) {
      // Nothing to filter on yet: applying would blank the table for no reason.
      return;
    }
    onChange(next);
    setOpen(false);
  };

  const clear = () => {
    onClear();
    setTicked([]);
    setValue('');
    setValue2('');
    setOpen(false);
  };

  return (
    <div className="cf" ref={wrapper}>
      <button
        type="button"
        className={`cf__btn${active ? ' cf__btn--on' : ''}`}
        aria-label={`Filter ${header}${active ? ' (active)' : ''}`}
        aria-expanded={open}
        title={active ? 'A filter is applied to this column' : 'Filter this column'}
        onClick={() => setOpen((current) => !current)}
      >
        <FilterIcon size={11} />
      </button>

      {open ? (
        <div className="cf__panel" role="dialog" aria-label={`Filter ${header}`}>
          <p className="cf__title">{header}</p>

          <label className="cf__label" htmlFor={`cf-op-${columnKey}`}>
            Show rows where
          </label>
          <select
            id={`cf-op-${columnKey}`}
            className="cf__control"
            value={op}
            onChange={(event) => setOp(event.target.value as FilterOp)}
          >
            {ops.map((entry) => (
              <option key={entry.op} value={entry.op}>
                {entry.label}
              </option>
            ))}
          </select>

          {needsValue ? (
            <input
              type={dateColumn && (op === 'gte' || op === 'lte' || op === 'between' || op === 'equals') ? 'date' : 'text'}
              className="cf__control"
              placeholder={dateColumn ? 'yyyy-mm-dd' : `Type a ${header.toLowerCase()}…`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') apply();
              }}
              autoFocus
            />
          ) : null}

          {op === 'between' ? (
            <input
              type={dateColumn ? 'date' : 'text'}
              className="cf__control"
              placeholder="and…"
              value={value2}
              onChange={(event) => setValue2(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') apply();
              }}
            />
          ) : null}

          {needsValues ? (
            <div className="cf__values">
              {choices.values.length === 0 ? (
                <p className="cf__empty">No values in this column.</p>
              ) : (
                choices.values.map((choice) => {
                  const on = ticked.some((entry) => entry.toLowerCase() === choice.value.toLowerCase());
                  return (
                    <label key={choice.value} className={`cf__value${on ? ' cf__value--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setTicked((current) =>
                            on
                              ? current.filter((entry) => entry.toLowerCase() !== choice.value.toLowerCase())
                              : [...current, choice.value],
                          )
                        }
                      />
                      <span className="cf__value-text">{choice.value || '—'}</span>
                      <span className="cf__value-count">{choice.count}</span>
                      {on ? <CheckIcon size={11} /> : null}
                    </label>
                  );
                })
              )}
              {choices.truncated ? <p className="cf__hint">Showing the 100 most common values.</p> : null}
              {choices.blankCount > 0 ? (
                <p className="cf__hint">
                  {choices.blankCount.toLocaleString('en-US')} blank row{choices.blankCount === 1 ? '' : 's'} — use “Is
                  blank” to see them.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="cf__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
              Clear
            </button>
            <button type="button" className="btn btn--dark btn--sm" onClick={apply} disabled={needsValues && ticked.length === 0}>
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

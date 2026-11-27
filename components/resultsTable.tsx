'use client';

import { useMemo, useState } from 'react';
import { REQUIRED_COLUMNS, SUPPORTING_COLUMNS, statusLabel } from '@/lib/export';
import { ariaSortFor, nextSortState, sortRows, type SortState } from '@/lib/sortRows';
import type { CarrierEnrichment } from '@/lib/types';
import { SortIcon } from './icons';

interface ResultsTableProps {
  rows: CarrierEnrichment[];
  selected: CarrierEnrichment | null;
  onSelect: (row: CarrierEnrichment) => void;
}

type Filter = 'all' | 'enriched' | 'partial' | 'missing_policy' | 'attention';

const PAGE_SIZE = 100;

function statusTone(status: CarrierEnrichment['status']): string {
  switch (status) {
    case 'enriched':
      return 'pill--ok';
    case 'partial':
      return 'pill--warn';
    case 'not_found':
    case 'invalid':
      return 'pill--bad';
    default:
      return 'pill--neutral';
  }
}

/** Hidden by default; toggled from the toolbar to keep required columns in view. */
const OPTIONAL_SUPPORTING = new Set(['dba', 'insurer', 'coverage', 'usdot_status', 'power_units', 'policy_count']);

/**
 * Preview of the export. Column order and labels come from the same definitions
 * the CSV writer uses, so what you sort here is what you download.
 */
export function ResultsTable({ rows, selected, onSelect }: ResultsTableProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [sort, setSort] = useState<SortState | null>(null);
  const [showMoreColumns, setShowMoreColumns] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === 'enriched' && row.status !== 'enriched') return false;
      if (filter === 'partial' && row.status !== 'partial') return false;
      if (filter === 'missing_policy' && row.policy?.policyNumber) return false;
      if (
        filter === 'attention' &&
        !(row.status === 'retry' || row.status === 'invalid' || row.status === 'not_found' || row.needsCorrection)
      ) {
        return false;
      }
      if (!needle) return true;
      return [row.dot, row.legalName, row.dbaName, row.contactName, row.email, row.phone, row.policy?.policyNumber]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [rows, filter, query]);

  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);
  const page = sorted.slice(0, visible);

  const columns = useMemo(() => {
    if (!showMoreColumns) return REQUIRED_COLUMNS;
    const extra = SUPPORTING_COLUMNS.filter((column) => OPTIONAL_SUPPORTING.has(column.key));
    return [...REQUIRED_COLUMNS, ...extra];
  }, [showMoreColumns]);

  const toggleSort = (key: string) => {
    setSort((current) => nextSortState(current, key));
    setVisible(PAGE_SIZE);
  };

  const missingPolicyCount = rows.filter((row) => !row.policy?.policyNumber).length;

  return (
    <div className="stack">
      <div className="filters">
        <input
          className="input"
          type="search"
          placeholder="Search DOT, company, email…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisible(PAGE_SIZE);
          }}
          aria-label="Search enriched rows"
        />
        {(
          [
            ['all', `All ${rows.length}`],
            ['enriched', 'Enriched'],
            ['partial', 'Partial'],
            ['missing_policy', `No policy ${missingPolicyCount}`],
            ['attention', 'Needs attention'],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setVisible(PAGE_SIZE);
            }}
          >
            {label}
          </button>
        ))}

        <button
          type="button"
          className="chip"
          aria-pressed={showMoreColumns}
          onClick={() => setShowMoreColumns((value) => !value)}
        >
          {showMoreColumns ? 'Fewer columns' : 'More columns'}
        </button>

        {sort ? (
          <button type="button" className="linkish" onClick={() => setSort(null)}>
            Reset sort
          </button>
        ) : null}

        <span className="xsmall muted" style={{ marginLeft: 'auto' }}>
          Showing {page.length} of {filtered.length}
          {sort ? ' · sorted' : ''}
        </span>
      </div>

      <div className="table-wrap">
        <table className="grid">
          <caption className="visually-hidden">
            Enriched carrier rows. Click a column heading to sort; select a row to inspect its FMCSA sources.
          </caption>
          <thead>
            <tr>
              {columns.map((column, index) => {
                const state = ariaSortFor(sort, column.key);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={[
                      'required',
                      index === 0 ? 'sticky-col' : '',
                      'sortable',
                      state !== 'none' ? 'sorted' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-sort={state}
                  >
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort(column.key)}
                      title={`Sort by ${column.header}`}
                    >
                      <span>{column.header}</span>
                      <SortIcon direction={state === 'none' ? null : sort?.direction ?? null} />
                    </button>
                  </th>
                );
              })}
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {page.map((row) => {
              const attention =
                row.status === 'retry' || row.status === 'invalid' || row.status === 'not_found' || row.needsCorrection;
              const isSelected = selected?.dot === row.dot && selected?.status === row.status;
              return (
                <tr
                  key={row.dot + row.status}
                  className={attention ? 'row--attention' : undefined}
                  tabIndex={0}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => onSelect(row)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(row);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {columns.map((column, index) => {
                    const value = column.value(row);
                    const blank = value === '' || value === null || value === undefined;
                    return (
                      <td
                        key={column.key}
                        className={index === 0 ? 'cell-dot sticky-col' : column.key === 'created' ? 'mono xsmall' : ''}
                      >
                        {column.key === 'status' ? (
                          <span className={`pill ${statusTone(row.status)}`}>{statusLabel(row.status)}</span>
                        ) : blank ? (
                          <span className="cell-empty">—</span>
                        ) : (
                          String(value)
                        )}
                      </td>
                    );
                  })}
                  <td className="cell-notes">{row.notes[0] ?? '—'}</td>
                </tr>
              );
            })}
            {page.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} style={{ padding: '24px 12px', textAlign: 'center' }}>
                  <span className="muted small">No rows match this filter.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {visible < filtered.length ? (
        <div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, filtered.length - visible)} more rows
          </button>
        </div>
      ) : null}
    </div>
  );
}

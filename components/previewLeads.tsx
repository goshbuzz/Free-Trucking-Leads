'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertIcon, CheckIcon, DownloadIcon, InfoIcon, PlayIcon, RefreshIcon } from './icons';
import { CARGO_TYPES, cargoLabel } from '@/lib/leads/cargo';
import {
  DEFAULT_FILTERS,
  LEAD_CATEGORIES,
  applyCategory,
  describeFilters,
  findCategory,
  normaliseFilters,
  parseKeywords,
  type LeadFilters,
} from '@/lib/leads/filters';
import { buildLeadCsv, LEAD_COLUMNS, leadFilename } from '@/lib/leads/export';
import { applyColumnFilters, describeFilter, isFilterIncomplete, type ColumnFilter } from '@/lib/leads/columnFilters';
import { ColumnFilterButton } from './columnFilter';
import { parseStateList, summariseStates, unrecognisedStates, US_STATES } from '@/lib/leads/states';
import type { LeadRow, LeadSearchResponse } from '@/lib/types';
import type { LeadFunnel } from '@/lib/leads/funnel';

/**
 * One card per filtering step, in the same row-and-card style as the four
 * summary cards above, so the drop between "census matches" and "leads
 * returned" is visible without hunting for a separate report.
 */
export function LeadFunnelCards({
  funnel,
  onOpenRejected,
  openReason,
  rejectedCounts,
}: {
  funnel?: LeadFunnel | null;
  /** Open the carriers behind a drop. Absent reasons have no stored rows. */
  onOpenRejected?: (reason: string) => void;
  openReason?: string | null;
  /** How many rows are actually available to show, per reason. */
  rejectedCounts?: Record<string, number>;
}) {
  if (!funnel || funnel.stages.length === 0) return null;

  // Census and the returned total already have their own cards above.
  const steps = funnel.stages.filter((stage) => stage.key !== 'census' && stage.key !== 'returned');
  if (steps.length === 0) return null;

  return (
    <div className="funnel-cards">
      <div className="funnel-cards__head">
        <h3 className="funnel-cards__title">Where the leads went</h3>
        <p className="funnel-cards__summary">{funnel.summary}</p>
      </div>
      <div className="lead-stats lead-stats--funnel">
        {steps.map((stage) => {
          const isDrop = stage.dropped > 0;
          const isLimit = stage.key === 'limit';
          const share = funnel.drops.find((drop) => `drop:${drop.reason}` === stage.key)?.share ?? null;
          const reason = stage.key.startsWith('drop:') ? stage.key.slice('drop:'.length) : null;
          const available = reason ? (rejectedCounts?.[reason] ?? 0) : 0;
          const openable = Boolean(reason && isDrop && available > 0 && onOpenRejected);
          const isOpen = openable && openReason === reason;

          const inner = (
            <>
              <p className="lead-stat__label">{stage.label}</p>
              <p className="lead-stat__value">
                {isDrop ? `\u2212${stage.dropped.toLocaleString('en-US')}` : stage.count.toLocaleString('en-US')}
              </p>
              <p className="lead-stat__sub">
                {stage.detail}
                {isDrop
                  ? ` \u00b7 ${stage.remaining.toLocaleString('en-US')} left${
                      share !== null ? ` \u00b7 ${Math.round(share * 100)}% of those dropped` : ''
                    }`
                  : ''}
              </p>
              {openable ? (
                <p className="lead-stat__action">{isOpen ? 'Showing below' : 'View these leads \u2192'}</p>
              ) : null}
            </>
          );

          const className = [
            'lead-stat',
            isDrop ? 'lead-stat--drop' : 'lead-stat--flow',
            isLimit ? 'lead-stat--limit' : '',
            openable ? 'lead-stat--button' : '',
            isOpen ? 'lead-stat--open' : '',
          ]
            .filter(Boolean)
            .join(' ');

          if (!openable) {
            return (
              <div key={stage.key} className={className}>
                {inner}
              </div>
            );
          }

          return (
            <button
              key={stage.key}
              type="button"
              className={className}
              onClick={() => onOpenRejected?.(reason as string)}
              aria-expanded={isOpen}
              aria-controls={isOpen ? 'rejected-panel' : undefined}
              title={`Show the ${available.toLocaleString('en-US')} carriers behind this count`}
            >
              {inner}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The carriers behind one funnel card.
 *
 * Same columns and same CSV builder as the lead table, because the question
 * ("who did this rule remove?") is answered by the same fields. Counts come from
 * the exact funnel tally; the list can be capped, and says so when it is.
 */
export function RejectedLeadsPanel({
  reason,
  label,
  detail,
  rows,
  total,
  truncated,
  onClose,
  onDownload,
}: {
  reason: string;
  label: string;
  detail: string;
  rows: LeadRow[];
  /** Exact count removed by this rule, which can exceed `rows.length`. */
  total: number;
  truncated: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
  const safePage = Math.min(page, pageCount - 1);
  const visible = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <section className="rejected" id="rejected-panel" aria-labelledby="rejected-title">
      <div className="rejected__head">
        <div>
          <h3 className="rejected__title" id="rejected-title">
            {label} · {total.toLocaleString('en-US')} {total === 1 ? 'carrier' : 'carriers'}
          </h3>
          <p className="rejected__detail">{detail}</p>
          {truncated ? (
            <p className="rejected__note">
              Showing the first {rows.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')}. The count
              above is exact; the list is capped so the page stays fast.
            </p>
          ) : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn--dark btn--sm" onClick={onDownload} disabled={rows.length === 0}>
            <DownloadIcon /> Download CSV
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rejected__empty">No carrier rows were kept for this rule in this search.</p>
      ) : (
        <>
          <div className="table-wrap lead-table-wrap rejected__table">
            <table className="grid lead-grid">
              <caption className="visually-hidden">
                {label}: {total} carriers filtered out by this rule, shown in the same columns as the leads.
              </caption>
              <thead>
                <tr>
                  {LEAD_COLUMNS.map((column) => (
                    <th key={column.key} scope="col">
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={`${reason}-${row.dot}`}>
                    {LEAD_COLUMNS.map((column, index) => {
                      const value = column.value(row);
                      const blank = value === '' || value === null || value === undefined;
                      return (
                        <td key={column.key} className={index === 0 ? 'cell-dot sticky-col' : undefined}>
                          {blank ? <span className="muted">—</span> : value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <div className="lead-pager">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setPage((value) => Math.max(value - 1, 0))}
                disabled={safePage === 0}
              >
                Previous
              </button>
              <span className="xsmall muted">
                Page {safePage + 1} of {pageCount} · {rows.length.toLocaleString('en-US')} rows
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setPage((value) => Math.min(value + 1, pageCount - 1))}
                disabled={safePage >= pageCount - 1}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

interface PreviewLeadsProps {
  maxRows: number;
  mockMode: boolean;
}

const STORAGE_KEY = 'dot-enricher:lead-filters:v1';
const PAGE_SIZE = 100;

function isoToday(offsetDays = 0): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toISOString().slice(0, 10);
}

function isoYearsAgo(years: number): string {
  const now = new Date();
  now.setUTCFullYear(now.getUTCFullYear() - years);
  return now.toISOString().slice(0, 10);
}

function formatUs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

function formatBound(from: string | null | undefined, to: string | null | undefined): string | null {
  if (from && to) return `${formatUs(from)} → ${formatUs(to)}`;
  if (from) return `from ${formatUs(from)}`;
  if (to) return `up to ${formatUs(to)}`;
  return null;
}

function describeDateSummary(
  effFrom: string | null | undefined,
  effTo: string | null | undefined,
  expFrom: string | null | undefined,
  expTo: string | null | undefined,
): string {
  const eff = formatBound(effFrom, effTo);
  const exp = formatBound(expFrom, expTo);
  if (eff && exp) return `Effective: ${eff} · Expiry: ${exp}`;
  if (eff) return `Effective: ${eff} · Expiry: Any`;
  if (exp) return `Effective: Any · Expiry: ${exp}`;
  return 'No date filter selected';
}

interface SavedProfile {
  category: string;
  filters: LeadFilters;
}

function loadProfile(): SavedProfile {
  const fallback: SavedProfile = { category: 'new_authority', filters: DEFAULT_FILTERS };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { category?: unknown; filters?: unknown };
    return {
      category: typeof parsed.category === 'string' && findCategory(parsed.category) ? parsed.category : fallback.category,
      filters: normaliseFilters(parsed.filters),
    };
  } catch {
    return fallback;
  }
}

interface DraftFilters extends Omit<LeadFilters, 'states' | 'excludedStates' | 'excludedKeywords'> {
  /** Raw text as typed, so "Tex" is not thrown away mid-keystroke. */
  states: string;
  excludedStates: string;
  excludedKeywords: string;
}

function toDraft(filters: LeadFilters): DraftFilters {
  return {
    ...filters,
    states: filters.states.join(', '),
    excludedStates: filters.excludedStates.join(', '),
    excludedKeywords: filters.excludedKeywords.join(', '),
  };
}

function toFilters(draft: DraftFilters): LeadFilters {
  return normaliseFilters({
    ...draft,
    states: parseStateList(draft.states),
    excludedStates: parseStateList(draft.excludedStates),
    excludedKeywords: parseKeywords(draft.excludedKeywords),
  });
}

/**
 * Preview Leads — search FMCSA's public files by date range and filters, review
 * the result, then download it. Nothing is written anywhere: this screen only
 * reads published open data.
 */
export function PreviewLeads({ maxRows, mockMode }: PreviewLeadsProps) {
  const [category, setCategory] = useState('new_authority');
  const [draft, setDraft] = useState<DraftFilters>(() => toDraft(DEFAULT_FILTERS));
  const [applied, setApplied] = useState<LeadFilters>(DEFAULT_FILTERS);
  const [editing, setEditing] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(() => isoYearsAgo(1));
  const [effectiveTo, setEffectiveTo] = useState(() => isoToday());
  const [expiryFrom, setExpiryFrom] = useState('');
  const [expiryTo, setExpiryTo] = useState('');
  const [limit, setLimit] = useState(250);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [response, setResponse] = useState<LeadSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<LeadRow | null>(null);
  /** Funnel reason whose rejected carriers are open below the cards. */
  const [openReason, setOpenReason] = useState<string | null>(null);
  /**
   * Per-column filters on the result table. These narrow what is already on
   * screen; they are never sent to FMCSA, so applying one is instant.
   */
  const [columnFilters, setColumnFilters] = useState<ColumnFilter[]>([]);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(0);

  /* Restore the last saved filter profile after mount (localStorage is client-only). */
  useEffect(() => {
    const restored = loadProfile();
    setCategory(restored.category);
    setDraft(toDraft(restored.filters));
    setApplied(restored.filters);
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsed(Date.now() - startedRef.current), 250);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!savedFlash) return;
    const timer = setTimeout(() => setSavedFlash(null), 2600);
    return () => clearTimeout(timer);
  }, [savedFlash]);

  const maxAllowedLimit = Math.min(maxRows, 2000);
  const effectiveLimit = limit === 0 ? maxAllowedLimit : limit;
  const rows = response?.rows ?? [];
  const meta = response?.meta ?? null;
  const rejected = response?.rejected ?? {};
  const rejectedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [reason, list] of Object.entries(rejected)) counts[reason] = list?.length ?? 0;
    return counts;
  }, [rejected]);

  const openRejected = openReason ? (rejected[openReason] ?? []) : [];
  const openStage = openReason
    ? (meta?.funnel.stages.find((stage) => stage.key === `drop:${openReason}`) ?? null)
    : null;
  const openDrop = openReason ? (meta?.funnel.drops.find((drop) => drop.reason === openReason) ?? null) : null;
  const openTruncated = Boolean(openReason && response?.rejectedTruncated?.includes(openReason));
  const statesWarning = useMemo(() => unrecognisedStates(draft.states), [draft.states]);
  const excludedStatesWarning = useMemo(() => unrecognisedStates(draft.excludedStates), [draft.excludedStates]);
  const draftFilters = useMemo(() => toFilters(draft), [draft]);
  const dirty = useMemo(
    () => JSON.stringify(draftFilters) !== JSON.stringify(applied),
    [draftFilters, applied],
  );

  const runSearch = useCallback(
    async (filters: LeadFilters, includeRejectedFlag: boolean) => {
      setError(null);
      setRunning(true);
      setSelected(null);
      setElapsed(0);
      startedRef.current = Date.now();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            effectiveFrom: effectiveFrom || null,
            effectiveTo: effectiveTo || null,
            expiryFrom: expiryFrom || null,
            expiryTo: expiryTo || null,
            limit: effectiveLimit,
            includeRejected: includeRejectedFlag,
            filters,
          }),
          signal: controller.signal,
        });
        const payload = (await res.json()) as LeadSearchResponse | { error?: string };
        if (!res.ok || 'error' in payload) {
          throw new Error(
            ('error' in payload && payload.error) || `The lead search failed (HTTP ${res.status}).`,
          );
        }
        setResponse(payload as LeadSearchResponse);
        setOpenReason(null);
        setColumnFilters([]);
        setVisible(PAGE_SIZE);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setError('Search cancelled.');
        } else {
          setError(err instanceof Error ? err.message : 'The lead search failed.');
        }
        setResponse(null);
        setOpenReason(null);
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [effectiveFrom, effectiveTo, expiryFrom, expiryTo, effectiveLimit],
  );

  const preview = useCallback(() => {
    void runSearch(applied, includeRejected);
  }, [runSearch, applied, includeRejected]);

  const save = useCallback(() => {
    const next = draftFilters;
    setApplied(next);
    setDraft(toDraft(next));
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ category, filters: next } satisfies SavedProfile));
      setSavedFlash('Filters saved — they are used for every preview and import until you reset them.');
    } catch {
      setSavedFlash('Filters applied. This browser blocked local storage, so they reset on reload.');
    }
    setEditing(false);
  }, [draftFilters, category]);

  const reset = useCallback(() => {
    setCategory('new_authority');
    setDraft(toDraft(DEFAULT_FILTERS));
    setApplied(DEFAULT_FILTERS);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage blocked — nothing to clear */
    }
    setSavedFlash('Filters reset to the default lead profile.');
    setEditing(false);
  }, []);

  /**
   * The lead category sits outside the filter editor, so it applies at once —
   * picking "Insured Carriers" should change the next preview without a Save.
   */
  const chooseCategory = useCallback(
    (id: string) => {
      setCategory(id);
      const next = applyCategory(applied, id);
      setApplied(next);
      setDraft(toDraft(next));
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ category: id, filters: next } satisfies SavedProfile));
      } catch {
        /* storage blocked — the choice still applies to this session */
      }
    },
    [applied],
  );

  const toggleCargo = useCallback((id: string) => {
    setDraft((current) => {
      const list = current.excludedCargo.includes(id)
        ? current.excludedCargo.filter((value) => value !== id)
        : [...current.excludedCargo, id];
      return { ...current, excludedCargo: CARGO_TYPES.filter((type) => list.includes(type.id)).map((type) => type.id) };
    });
  }, []);

  /** Rows after the per-column filters. `rows` stays the full result. */
  const filteredRows = useMemo(() => applyColumnFilters(rows, columnFilters), [rows, columnFilters]);
  const visibleRows = filteredRows.slice(0, visible);

  const activeColumnFilters = columnFilters.filter((filter) => !isFilterIncomplete(filter));
  const headerFor = (key: string) => LEAD_COLUMNS.find((column) => column.key === key)?.header ?? key;
  const setColumnFilter = (next: ColumnFilter) =>
    setColumnFilters((current) => [...current.filter((entry) => entry.columnKey !== next.columnKey), next]);
  const clearColumnFilter = (key: string) =>
    setColumnFilters((current) => current.filter((entry) => entry.columnKey !== key));

  // A new filter makes the old row window meaningless, so show from the top.
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [columnFilters]);

  const activeFilters = activeColumnFilters.length;

  const downloadRejected = useCallback(() => {
    if (!openReason || openRejected.length === 0) return;
    const blob = new Blob([buildLeadCsv(openRejected)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = leadFilename(new Date(), openReason.replace(/_/g, '-'));
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [openReason, openRejected]);

  /**
   * Exports what the table is showing, not the unfiltered result.
   *
   * Downloading 1,432 rows when the table reads "12 of 1,432" would be a quiet
   * way to hand someone a file they did not ask for, so the column filters
   * apply to the export too and the filename marks it as filtered.
   */
  const download = useCallback(() => {
    if (filteredRows.length === 0) return;
    const blob = new Blob([buildLeadCsv(filteredRows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = leadFilename(new Date(), activeFilters > 0 ? 'filtered' : undefined);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [filteredRows, activeFilters]);

  const hasEffective = Boolean(effectiveFrom || effectiveTo);
  const hasExpiry = Boolean(expiryFrom || expiryTo);
  const hasAnyDate = hasEffective || hasExpiry;
  const effectiveInvalid = Boolean(effectiveFrom && effectiveTo && effectiveFrom > effectiveTo);
  const expiryInvalid = Boolean(expiryFrom && expiryTo && expiryFrom > expiryTo);

  const rangeLabel = useMemo(
    () => describeDateSummary(effectiveFrom, effectiveTo, expiryFrom, expiryTo),
    [effectiveFrom, effectiveTo, expiryFrom, expiryTo],
  );
  const effectiveLabel = useMemo(() => formatBound(effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]);
  const expiryLabel = useMemo(() => formatBound(expiryFrom, expiryTo), [expiryFrom, expiryTo]);
  const metaRangeLabel = useMemo(
    () =>
      meta
        ? describeDateSummary(meta.effectiveFrom, meta.effectiveTo, meta.expiryFrom, meta.expiryTo)
        : rangeLabel,
    [meta, rangeLabel],
  );

  return (
    <section className="card" aria-labelledby="preview-leads-heading">
      <div className="card__body">
        <div className="card__head">
          <div>
            <p className="eyebrow">Research workspace</p>
            <h1 id="preview-leads-heading" className="title-lg">
              Preview Leads
            </h1>
          </div>
          <p className="small muted" style={{ textAlign: 'right', maxWidth: 340 }}>
            Filter by policy effective date and/or expiry date separately, review leads, and download CSV.
          </p>
        </div>

        {mockMode ? (
          <div className="notice notice--warn" style={{ marginBottom: 14 }}>
            <AlertIcon />
            <span>
              <strong>Demo mode.</strong> MOCK_FMCSA=1 is set, so these leads are generated locally instead of read from FMCSA.
            </span>
          </div>
        ) : null}

        {/* ------------------------------------------------------------------ */}
        {/* Category + separate Effective & Expiry date ranges + limit          */}
        {/* ------------------------------------------------------------------ */}
        <div className="lead-controls">
          <div className="lead-date-grid">
            <div className="field field--category">
              <label className="field__label" htmlFor="lead-category">
                Lead Category
              </label>
              <select
                id="lead-category"
                className="field__control"
                value={category}
                onChange={(event) => chooseCategory(event.target.value)}
              >
                {LEAD_CATEGORIES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="field__hint">{findCategory(category)?.hint ?? ''}</span>
            </div>

            {/* Effective Date Range */}
            <fieldset className={`date-group${hasEffective ? ' date-group--active' : ''}`}>
              <legend className="visually-hidden">Effective date range</legend>
              <div className="date-group__head">
                <div className="date-group__titles">
                  <span className="date-group__title">Effective Date</span>
                  <span className="date-group__tag">
                    {applied.insurance === 'no' ? 'Census added' : 'Policy start'}
                  </span>
                </div>
                {hasEffective ? (
                  <button
                    type="button"
                    className="date-group__action"
                    onClick={() => {
                      setEffectiveFrom('');
                      setEffectiveTo('');
                    }}
                  >
                    Clear
                  </button>
                ) : (
                  <button
                    type="button"
                    className="date-group__action"
                    onClick={() => {
                      setEffectiveFrom(isoYearsAgo(1));
                      setEffectiveTo(isoToday());
                    }}
                  >
                    Last 12 mo
                  </button>
                )}
              </div>
              <div className="date-group__fields">
                <div className="field">
                  <label className="field__label" htmlFor="lead-effective-from">
                    From
                  </label>
                  <input
                    id="lead-effective-from"
                    className="field__control"
                    type="date"
                    value={effectiveFrom}
                    max={effectiveTo || undefined}
                    onChange={(event) => setEffectiveFrom(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="lead-effective-to">
                    To
                  </label>
                  <input
                    id="lead-effective-to"
                    className="field__control"
                    type="date"
                    value={effectiveTo}
                    min={effectiveFrom || undefined}
                    onChange={(event) => setEffectiveTo(event.target.value)}
                  />
                </div>
              </div>
              {effectiveInvalid ? (
                <span className="field__hint field__hint--warn">Effective &ldquo;From&rdquo; must be on or before &ldquo;To&rdquo;.</span>
              ) : (
                <span className="field__hint">
                  {hasEffective
                    ? applied.insurance === 'no'
                      ? 'FMCSA census registration date'
                      : 'Policy effective date range'
                    : 'Any effective date (not filtered)'}
                </span>
              )}
            </fieldset>

            {/* Expiry Date Range */}
            <fieldset className={`date-group${hasExpiry ? ' date-group--active' : ''}`}>
              <legend className="visually-hidden">Expiry date range</legend>
              <div className="date-group__head">
                <div className="date-group__titles">
                  <span className="date-group__title">Expiry Date</span>
                  <span className="date-group__tag">Policy expiring</span>
                </div>
                {hasExpiry ? (
                  <button
                    type="button"
                    className="date-group__action"
                    onClick={() => {
                      setExpiryFrom('');
                      setExpiryTo('');
                    }}
                  >
                    Clear
                  </button>
                ) : (
                  <button
                    type="button"
                    className="date-group__action"
                    onClick={() => {
                      setExpiryFrom(isoToday());
                      setExpiryTo(isoToday(90));
                    }}
                  >
                    Next 90 days
                  </button>
                )}
              </div>
              <div className="date-group__fields">
                <div className="field">
                  <label className="field__label" htmlFor="lead-expiry-from">
                    From
                  </label>
                  <input
                    id="lead-expiry-from"
                    className="field__control"
                    type="date"
                    value={expiryFrom}
                    max={expiryTo || undefined}
                    onChange={(event) => setExpiryFrom(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="lead-expiry-to">
                    To
                  </label>
                  <input
                    id="lead-expiry-to"
                    className="field__control"
                    type="date"
                    value={expiryTo}
                    min={expiryFrom || undefined}
                    onChange={(event) => setExpiryTo(event.target.value)}
                  />
                </div>
              </div>
              {expiryInvalid ? (
                <span className="field__hint field__hint--warn">Expiry &ldquo;From&rdquo; must be on or before &ldquo;To&rdquo;.</span>
              ) : (
                <span className="field__hint">
                  {hasExpiry
                    ? 'Policy cancellation / expiring date range'
                    : 'Any expiry date (leave blank for active policies with no cancellation)'}
                </span>
              )}
            </fieldset>
          </div>

          <div className="lead-action-bar">
            <p className={`xsmall ${!hasAnyDate ? 'field__hint--warn' : 'muted'}`}>
              {!hasAnyDate
                ? 'Choose at least an Effective Date range or an Expiry Date range to run Preview Leads.'
                : hasEffective && hasExpiry
                  ? 'Smart filter active: leads must satisfy both the Effective Date range and the Expiry Date range.'
                  : hasEffective
                    ? 'Filtering by Effective Date only. Fill Expiry Date too if you want to narrow by both.'
                    : 'Filtering by Expiry Date only. Fill Effective Date too if you want to narrow by both.'}
            </p>
            <div className="lead-action-bar__controls">
              <div className="field field--limit-inline">
                <label className="field__label" htmlFor="lead-limit">
                  Limit
                </label>
                <div className="lead-limit-wrap">
                  <input
                    id="lead-limit"
                    className="field__control"
                    type="number"
                    min={0}
                    max={maxAllowedLimit}
                    value={limit}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setLimit(Number.isFinite(next) && next > 0 ? Math.min(next, maxAllowedLimit) : 0);
                    }}
                  />
                  <span className="field__hint">
                    {limit === 0
                      ? `No limit (max ${maxAllowedLimit.toLocaleString('en-US')})`
                      : `Max ${maxAllowedLimit.toLocaleString('en-US')}`}
                  </span>
                </div>
              </div>
              <label className="checkbox checkbox--inline">
                <input
                  type="checkbox"
                  checked={includeRejected}
                  onChange={(event) => setIncludeRejected(event.target.checked)}
                />
                <span>Include rejected</span>
              </label>
              <button
                type="button"
                className="btn btn--primary lead-range__go"
                onClick={preview}
                disabled={running || !hasAnyDate || effectiveInvalid || expiryInvalid}
              >
                {running ? (
                  <>
                    <span className="spinner" /> Searching…
                  </>
                ) : (
                  <>
                    <PlayIcon size={15} /> Preview Leads
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Active filter strip                                                 */}
        {/* ------------------------------------------------------------------ */}
        <div className="filter-strip">
          <div className="filter-strip__inner">
            <p className="eyebrow eyebrow--navy">Active lead filters</p>
            <p className="filter-strip__summary">{describeFilters(applied)}</p>
            <p className="xsmall muted" style={{ marginTop: 6 }}>
              These filters apply to both previews and downloads. {rangeLabel} · limit{' '}
              {limit === 0 ? 'none' : limit.toLocaleString('en-US')}
              {includeRejected ? ' · rejected records included' : ''}
            </p>
            <p className="xsmall" style={{ marginTop: 6, color: 'var(--navy-500)' }}>
              {hasEffective && hasExpiry ? (
                applied.insurance === 'no' ? (
                  <>
                    <strong>Date filter reads as:</strong> census registration date ({effectiveLabel}) <strong>and</strong>{' '}
                    policy expiring date ({expiryLabel}).
                  </>
                ) : (
                  <>
                    <strong>Date filter reads as:</strong> policies with effective date ({effectiveLabel}){' '}
                    <strong>and</strong> expiring date ({expiryLabel}) on the same filing.
                  </>
                )
              ) : hasEffective ? (
                applied.insurance === 'no' ? (
                  <>
                    <strong>Date filter reads as:</strong> census registration date ({effectiveLabel}); any expiry date.
                  </>
                ) : (
                  <>
                    <strong>Date filter reads as:</strong> policy effective date ({effectiveLabel}); any expiry date
                    (including active policies with no cancellation filed).
                  </>
                )
              ) : hasExpiry ? (
                <>
                  <strong>Date filter reads as:</strong> policy expiring / cancellation date ({expiryLabel}), regardless
                  of when the policy started.
                </>
              ) : (
                <>
                  <strong>Date filter reads as:</strong> pick an Effective Date range, an Expiry Date range, or both.
                </>
              )}
            </p>
          </div>
          <button type="button" className="linkish" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Hide filters' : 'Edit filters'}
          </button>
        </div>

        {savedFlash ? (
          <div className="notice notice--info" style={{ marginTop: 12 }} role="status">
            <CheckIcon size={15} />
            <span>{savedFlash}</span>
          </div>
        ) : null}

        {/* ------------------------------------------------------------------ */}
        {/* Filter editor                                                       */}
        {/* ------------------------------------------------------------------ */}
        <div className={`filter-panel${editing ? ' filter-panel--open' : ''}`} hidden={!editing}>
          <div className="filter-panel__head">
            <p className="xsmall muted">
              These filters apply to both previews and downloads. Unknown state codes and keywords are ignored, never guessed.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn--ghost btn--sm" onClick={save}>
                Save
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
                Reset
              </button>
            </div>
          </div>

          <div className="filter-grid">
            <div className="field">
              <label className="checkbox" htmlFor="f-forhire">
                <input
                  id="f-forhire"
                  type="checkbox"
                  checked={draft.forHireOnly}
                  onChange={(event) => setDraft({ ...draft, forHireOnly: event.target.checked })}
                />
                <span>Freight motor carrier only</span>
              </label>
            </div>

            <div className="field">
              <label className="checkbox" htmlFor="f-tractor">
                <input
                  id="f-tractor"
                  type="checkbox"
                  checked={draft.truckTractorOnly}
                  onChange={(event) => setDraft({ ...draft, truckTractorOnly: event.target.checked })}
                />
                <span>Require truck tractor</span>
              </label>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-operation">
                Operation
              </label>
              <select
                id="f-operation"
                className="field__control"
                value={draft.operation}
                onChange={(event) => setDraft({ ...draft, operation: event.target.value as LeadFilters['operation'] })}
              >
                <option value="any">Any</option>
                <option value="interstate">Interstate</option>
                <option value="intrastate">Intrastate</option>
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-forhire-only">
                For Hire
              </label>
              <select
                id="f-forhire-only"
                className="field__control"
                value={draft.forHireOnly ? 'yes' : 'any'}
                onChange={(event) => setDraft({ ...draft, forHireOnly: event.target.value === 'yes' })}
              >
                <option value="yes">Yes</option>
                <option value="any">Any</option>
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-private">
                Private
              </label>
              <select
                id="f-private"
                className="field__control"
                value={draft.privatePolicy}
                onChange={(event) => setDraft({ ...draft, privatePolicy: event.target.value as LeadFilters['privatePolicy'] })}
              >
                <option value="exclude">Exclude private</option>
                <option value="include">Include private</option>
                <option value="only">Private only</option>
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-insurance">
                Insurance
              </label>
              <select
                id="f-insurance"
                className="field__control"
                value={draft.insurance}
                onChange={(event) => setDraft({ ...draft, insurance: event.target.value as LeadFilters['insurance'] })}
              >
                <option value="any">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-authority">
                Authority Status
              </label>
              <select
                id="f-authority"
                className="field__control"
                value={draft.authorityStatus}
                onChange={(event) =>
                  setDraft({ ...draft, authorityStatus: event.target.value as LeadFilters['authorityStatus'] })
                }
              >
                <option value="active">Active</option>
                <option value="any">Any</option>
                <option value="inactive">Inactive</option>
                <option value="pending">Pending</option>
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-excluded-states">
                Excluded States
              </label>
              <input
                id="f-excluded-states"
                className="field__control"
                type="text"
                placeholder="AK, CA, HI, NY, UT"
                value={draft.excludedStates}
                onChange={(event) => setDraft({ ...draft, excludedStates: event.target.value })}
              />
              {excludedStatesWarning.length > 0 ? (
                <span className="field__hint field__hint--warn">
                  Ignored: {excludedStatesWarning.join(', ')}
                </span>
              ) : (
                <span className="field__hint">Codes or full names, comma separated</span>
              )}
            </div>
          </div>

          {/* Including states — the single-state search ---------------------- */}
          <div className="filter-include">
            <div className="filter-include__head">
              <label className="field__label" htmlFor="f-include-states">
                Include States
              </label>
              <span className="xsmall muted">
                Search one state, several, or leave blank for every state.
              </span>
            </div>
            <div className="filter-include__body">
              <input
                id="f-include-states"
                className="field__control"
                type="text"
                placeholder="TX"
                value={draft.states}
                onChange={(event) => setDraft({ ...draft, states: event.target.value })}
                list="us-state-codes"
                autoComplete="off"
              />
              <datalist id="us-state-codes">
                {US_STATES.map((state) => (
                  <option key={state.code} value={state.code}>
                    {state.name}
                  </option>
                ))}
              </datalist>
              <div className="state-picks" role="group" aria-label="Quick state picks">
                {parseStateList(draft.states).map((code) => (
                  <button
                    key={code}
                    type="button"
                    className="state-chip"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        states: parseStateList(draft.states)
                          .filter((value) => value !== code)
                          .join(', '),
                      })
                    }
                    title={`Remove ${code}`}
                  >
                    {code} <span aria-hidden="true">×</span>
                  </button>
                ))}
                {['TX', 'OK', 'TN', 'OH', 'GA', 'FL', 'IL', 'PA']
                  .filter((code) => !parseStateList(draft.states).includes(code))
                  .slice(0, parseStateList(draft.states).length === 0 ? 8 : 4)
                  .map((code) => (
                    <button
                      key={code}
                      type="button"
                      className="state-chip state-chip--ghost"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          states: [...parseStateList(draft.states), code].sort().join(', '),
                        })
                      }
                    >
                      + {code}
                    </button>
                  ))}
              </div>
            </div>
            {statesWarning.length > 0 ? (
              <p className="field__hint field__hint--warn">
                Not a US state: {statesWarning.join(', ')} — only the 50 states and DC are searched.
              </p>
            ) : (
              <p className="field__hint">
                {draftFilters.states.length === 0
                  ? 'All states included'
                  : `Including ${draftFilters.states.map((code) => `${code} (${US_STATES.find((s) => s.code === code)?.name ?? code})`).join(', ')}`}
              </p>
            )}
          </div>

          <div className="filter-grid filter-grid--wide">
            <div className="field">
              <label className="field__label" htmlFor="f-keywords">
                Excluded Authority Keywords
              </label>
              <textarea
                id="f-keywords"
                className="field__control field__control--area"
                rows={3}
                placeholder="broker, freight forwarder, of household goods"
                value={draft.excludedKeywords}
                onChange={(event) => setDraft({ ...draft, excludedKeywords: event.target.value })}
              />
              <span className="field__hint">Matched against the legal and DBA name, case-insensitive</span>
            </div>

            <div className="field">
              <span className="field__label" id="cargo-label">
                Excluded Cargo Types
              </span>
              <div className="cargo-picks" role="group" aria-labelledby="cargo-label">
                {CARGO_TYPES.map((type) => {
                  const active = draft.excludedCargo.includes(type.id);
                  return (
                    <button
                      key={type.id}
                      type="button"
                      className={`cargo-chip${active ? ' cargo-chip--on' : ''}`}
                      aria-pressed={active}
                      onClick={() => toggleCargo(type.id)}
                      title={type.column ? `Census column ${type.column}` : 'No census column — informational only'}
                    >
                      {type.label}
                    </button>
                  );
                })}
              </div>
              <span className="field__hint">
                {draft.excludedCargo.length} excluded
                {draft.excludedCargo.includes('other') ? ' · “Other” has no FMCSA flag, so it is never excluded' : ''}
              </span>
            </div>
          </div>

          {dirty ? (
            <p className="xsmall" style={{ color: 'var(--gold-500)', marginTop: 10 }}>
              Unsaved changes — press Save to use them in the next preview.
            </p>
          ) : null}
        </div>

        {error ? (
          <div className="notice notice--error" style={{ marginTop: 14 }} role="alert">
            <AlertIcon />
            <span>{error}</span>
          </div>
        ) : null}

        {meta && meta.warnings.length > 0 ? (
          <div className="notice notice--warn" style={{ marginTop: 14 }}>
            <InfoIcon />
            <span>
              {meta.warnings.map((warning, index) => (
                <span key={index} style={{ display: 'block' }}>
                  {warning}
                </span>
              ))}
            </span>
          </div>
        ) : null}

        {/* ------------------------------------------------------------------ */}
        {/* Results                                                             */}
        {/* ------------------------------------------------------------------ */}
        {meta ? (
          <>
            <div className="lead-stats">
              <div className={`lead-stat${meta.complete === false ? ' lead-stat--limit' : ''}`}>
                <p className="lead-stat__label">Leads returned</p>
                <p className="lead-stat__value">{rows.length.toLocaleString('en-US')}</p>
                <p className="lead-stat__sub">
                  {meta.complete === false
                    ? `Incomplete batch · ${meta.unenrichedCount.toLocaleString('en-US')} waiting for MOTUS retry`
                    : meta.truncated
                      ? `Capped at the ${meta.limit.toLocaleString('en-US')} limit`
                      : 'All matching leads included'}
                </p>
              </div>
              <div className="lead-stat">
                <p className="lead-stat__label">Census matches</p>
                <p className="lead-stat__value">{meta.candidates === null ? '—' : meta.candidates.toLocaleString('en-US')}</p>
                <p className="lead-stat__sub">
                  {meta.candidates === null ? 'Expiry-only search (census not filtered by date)' : 'Registrations in effective range'}
                </p>
              </div>
              <div className="lead-stat">
                <p className="lead-stat__label">Insurance filings in range</p>
                <p className="lead-stat__value">
                  {meta.filingsInRange === null ? '—' : meta.filingsInRange.toLocaleString('en-US')}
                </p>
                <p className="lead-stat__sub">{metaRangeLabel}</p>
              </div>
              <div className="lead-stat">
                <p className="lead-stat__label">Run time</p>
                <p className="lead-stat__value">{(meta.elapsedMs / 1000).toFixed(1)}s</p>
                <p className="lead-stat__sub">{running ? 'Searching…' : `Scanned ${meta.scanned.toLocaleString('en-US')} census rows`}</p>
              </div>
            </div>

            <LeadFunnelCards
              funnel={meta.funnel}
              rejectedCounts={rejectedCounts}
              openReason={openReason}
              onOpenRejected={(reason) => setOpenReason((current) => (current === reason ? null : reason))}
            />

            {openReason && openStage && openDrop ? (
              <RejectedLeadsPanel
                reason={openReason}
                label={openDrop.label}
                detail={openStage.detail}
                rows={openRejected}
                total={openDrop.count}
                truncated={openTruncated}
                onClose={() => setOpenReason(null)}
                onDownload={downloadRejected}
              />
            ) : null}

            <div className="lead-toolbar">
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn--ghost btn--sm" onClick={preview} disabled={running}>
                  {running ? <span className="spinner spinner--dark" /> : <RefreshIcon size={14} />} Run again
                </button>
                <button type="button" className="btn btn--dark btn--sm" onClick={download} disabled={rows.length === 0}>
                  <DownloadIcon /> Download CSV
                </button>
              </div>
              <span className="xsmall muted">
                {elapsed > 0 && running ? `${(elapsed / 1000).toFixed(1)}s elapsed · ` : ''}
                {columnFilters.length > 0
                  ? `${filteredRows.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} rows · `
                  : `${rows.length} rows · `}
                {LEAD_COLUMNS.length} export columns
              </span>
            </div>

            {activeColumnFilters.length > 0 ? (
              <div className="cf-chips" role="region" aria-label="Active column filters">
                <span className="cf-chips__label">Table filters</span>
                {activeColumnFilters.map((filter) => (
                  <span className="cf-chip" key={filter.columnKey}>
                    {describeFilter(filter, headerFor(filter.columnKey))}
                    <button
                      type="button"
                      className="cf-chip__x"
                      aria-label={`Remove ${headerFor(filter.columnKey)} filter`}
                      onClick={() => clearColumnFilter(filter.columnKey)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button type="button" className="cf-chips__clear" onClick={() => setColumnFilters([])}>
                  Clear all
                </button>
              </div>
            ) : null}

            {rows.length > 0 ? (
              <div className="table-wrap lead-table-wrap">
                <table className="grid lead-grid">
                  <caption className="visually-hidden">
                    Lead preview: {rows.length} carriers matching the active filters, with the columns that will be exported.
                  </caption>
                  <thead>
                    <tr>
                      {LEAD_COLUMNS.map((column, index) => (
                        <th key={column.key} scope="col" className={index === 0 ? 'sticky-col' : undefined}>
                          <span className="th-inner">
                            <span className="th-label">{column.header}</span>
                            <ColumnFilterButton
                              columnKey={column.key}
                              header={column.header}
                              rows={rows}
                              filter={columnFilters.find((filter) => filter.columnKey === column.key)}
                              onChange={setColumnFilter}
                              onClear={() => clearColumnFilter(column.key)}
                            />
                          </span>
                        </th>
                      ))}
                      <th scope="col">Commodity detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr
                        key={row.dot}
                        tabIndex={0}
                        aria-current={selected?.dot === row.dot ? 'true' : undefined}
                        onClick={() => setSelected(row)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelected(row);
                          }
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        {LEAD_COLUMNS.map((column, index) => {
                          const value = column.value(row);
                          const blank = value === '' || value === null || value === undefined;
                          const isMatchedColumn =
                            ((row.matchDateKind === 'effective' || row.matchDateKind === 'both') &&
                              column.key === 'effective1') ||
                            ((row.matchDateKind === 'expiring' || row.matchDateKind === 'both') &&
                              column.key === 'expiring1');
                          return (
                            <td
                              key={column.key}
                              className={[
                                index === 0 ? 'cell-dot sticky-col' : '',
                                isMatchedColumn ? 'cell-matched' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              title={isMatchedColumn ? 'This is the date that matched your range' : undefined}
                            >
                              {column.key === 'active' && !blank ? (
                                <span className={`pill ${String(value) === 'Active' ? 'pill--ok' : 'pill--neutral'}`}>
                                  {String(value)}
                                </span>
                              ) : blank ? (
                                <span className="cell-empty">—</span>
                              ) : (
                                String(value)
                              )}
                            </td>
                          );
                        })}
                        <td className="cell-notes">
                          {row.cargo.length === 0 ? '—' : row.cargo.map((id) => cargoLabel(id)).join(', ')}
                          {row.cargoOther ? `${row.cargo.length ? ' · ' : ''}${row.cargoOther}` : ''}
                        </td>
                      </tr>
                    ))}
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={LEAD_COLUMNS.length + 1} style={{ padding: '22px 12px', textAlign: 'center' }}>
                          <span className="muted small">No leads matched these filters and dates.</span>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="notice notice--info" style={{ marginTop: 12 }}>
                <InfoIcon />
                <span>
                  No leads for {metaRangeLabel} with these filters. Try widening the Effective or Expiry date range, choosing
                  another state, or setting Insurance to “Any”.
                </span>
              </div>
            )}

            {visible < rows.length ? (
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, rows.length - visible)} more of {rows.length}
                </button>
              </div>
            ) : null}

            {selected ? <LeadDetail row={selected} onClose={() => setSelected(null)} /> : null}
          </>
        ) : null}

        {!meta && !running && !error ? (
          <div className="notice notice--info" style={{ marginTop: 16 }}>
            <InfoIcon />
            <span>
              Pick a date range and press <strong>Preview Leads</strong>. Results are read live from the FMCSA Company Census
              File and Motus insurance filings — nothing is saved and no contacts are created.
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Row detail                                                                 */
/* -------------------------------------------------------------------------- */

const STATE_NAME = new Map(US_STATES.map((state) => [state.code, state.name]));

function LeadDetail({ row, onClose }: { row: LeadRow; onClose: () => void }) {
  return (
    <div className="drawer">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <p className="eyebrow">Lead detail</p>
          <h3 style={{ fontSize: 16 }}>
            {row.legalName ?? `DOT ${row.dot}`} <span className="mono xsmall muted">· DOT {row.dot}</span>
          </h3>
        </div>
        <button type="button" className="linkish" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="detail-grid">
        <dl className="kv xsmall">
          <dt>Company rep</dt>
          <dd>
            {row.firstName || row.lastName
              ? [row.firstName, row.lastName].filter(Boolean).join(' ')
              : 'Not published by FMCSA'}
          </dd>
          <dt>MC docket</dt>
          <dd className="mono">{row.docket ?? '—'}</dd>
          <dt>DBA</dt>
          <dd>{row.dbaName ?? '—'}</dd>
          <dt>Physical address</dt>
          <dd>
            {[row.physicalStreet, row.city, row.state, row.physicalZip].filter(Boolean).join(', ') || '—'}
          </dd>
          <dt>Mailing address</dt>
          <dd>{[row.mailingStreet, row.mailingCity, row.mailingState, row.mailingZip].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Physical state</dt>
          <dd>{row.state ? `${row.state} — ${STATE_NAME.get(row.state) ?? row.state}` : '—'}</dd>
          <dt>Operating class</dt>
          <dd>{row.classDef ?? '—'}</dd>
          <dt>Authority</dt>
          <dd>
            {row.authorityLabel ?? '—'} <span className="mono muted">({row.authorityStatus ?? 'no code'})</span>
          </dd>
          <dt>Operation</dt>
          <dd>
            {row.operation ?? '—'} <span className="mono muted">({row.operationCode ?? '—'})</span>
          </dd>
        </dl>

        <dl className="kv xsmall">
          <dt>Insurer</dt>
          <dd>{row.insurer ?? '—'}</dd>
          <dt>Policy number</dt>
          <dd className="mono">{row.policyNumber ?? '—'}</dd>
          <dt>Policy type</dt>
          <dd>{row.policyType ?? '—'}</dd>
          <dt>Effective date</dt>
          <dd>{row.effectiveDate ?? '—'}</dd>
          <dt>Expiring date</dt>
          <dd>{row.expiringDate ?? '—'}</dd>
          <dt>Matched on</dt>
          <dd>
            {row.matchReason === 'both'
              ? `Policy effective ${row.effectiveDate ?? '—'} and expiring ${row.expiringDate ?? '—'} (both inside the ranges)`
              : row.matchReason === 'effective'
                ? `Policy effective ${row.matchedDate ?? '—'} (inside the effective date range)`
                : row.matchReason === 'cancellation'
                  ? `Policy expiring ${row.matchedDate ?? '—'} (inside the expiry date range)`
                  : row.matchReason === 'current'
                    ? 'Current filing — outside the selected dates'
                    : 'No insurance filing inside the range'}
          </dd>
          <dt>Cover live today</dt>
          <dd>{row.hasActiveCoverage ? 'Yes' : 'No'}</dd>
          <dt>Coverage</dt>
          <dd>{row.coverage ? `$${row.coverage.toLocaleString('en-US')}` : '—'}</dd>
          <dt>Equipment</dt>
          <dd>{row.equipment ?? '—'}</dd>
          <dt>Census added</dt>
          <dd>{row.addDate ?? '—'}</dd>
          <dt>MCS-150</dt>
          <dd>{row.mcs150Date ?? '—'}</dd>
        </dl>
      </div>

      <div className="sidebar-section" style={{ marginTop: 12 }}>
        <h4 style={{ fontSize: 13 }}>Commodities</h4>
        <p className="xsmall">
          {row.cargo.length > 0 ? row.cargo.map((id) => cargoLabel(id)).join(' · ') : 'No cargo boxes answered on the MCS-150.'}
          {row.cargoOther ? ` · Other: ${row.cargoOther}` : ''}
        </p>
      </div>

      {row.notes.length > 0 ? (
        <div className="sidebar-section" style={{ marginTop: 10 }}>
          <h4 style={{ fontSize: 13 }}>Notes</h4>
          <ul className="xsmall muted" style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {row.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="xsmall muted" style={{ marginTop: 10 }}>
        Sources: {row.sources.join(' · ')}
      </p>
    </div>
  );
}

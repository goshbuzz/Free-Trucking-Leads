'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDrop } from './fileDrop';
import { PreviewLeads } from './previewLeads';
import { ResultsTable } from './resultsTable';
import { RowDetail } from './rowDetail';
import { AlertIcon, CheckIcon, DownloadIcon, InfoIcon, RefreshIcon, ShieldIcon, TruckIcon } from './icons';
import { buildCsv, exportFilename, REQUIRED_COLUMNS, statusLabel, summarise } from '@/lib/export';
import { findDotColumn, hasDocketColumn, parseCsv } from '@/lib/csv';
import { parseDot } from '@/lib/normalize';
import type { CarrierEnrichment, EnrichResponse, ProviderStatus } from '@/lib/types';

interface EnricherProps {
  maxRows: number;
  maxFileBytes: number;
  mockMode: boolean;
  /** Resolved on the server, so a missing key is visible before any run. */
  serverHasKey: boolean;
}

type Phase = 'idle' | 'reading' | 'enriching' | 'done' | 'error';

interface ParsedUpload {
  headers: string[];
  dots: string[];
  columnName: string;
  duplicates: number;
  blank: number;
  docketWarning: boolean;
}

const SAMPLE_CSV = `DOT Number,Company,Notes
1515240,Example Carrier,keep your own column
12873,Another Carrier,uploaded rows stay in the export
`;

export function Enricher({ maxRows, maxFileBytes, mockMode, serverHasKey }: EnricherProps) {
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<ParsedUpload | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<EnrichResponse | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, startedAt: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [selected, setSelected] = useState<CarrierEnrichment | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [tab, setTab] = useState<'leads' | 'enrich'>('leads');
  const abortRef = useRef<AbortController | null>(null);

  const rows = response?.results ?? [];
  const summary = useMemo(() => summarise(rows), [rows]);

  /* Provider status, once on mount — drives the honesty of the empty state. */
  const loadStatus = useCallback(async (probe: boolean) => {
    setProbing(probe);
    setStatusError(null);
    try {
      const res = await fetch(`/api/status${probe ? '?probe=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Status check failed (HTTP ${res.status})`);
      setStatus((await res.json()) as ProviderStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Status check failed');
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  /* Live timer while a run is in flight. */
  useEffect(() => {
    if (phase !== 'enriching') return;
    const timer = setInterval(() => setElapsed(Date.now() - progress.startedAt), 250);
    return () => clearInterval(timer);
  }, [phase, progress.startedAt]);

  /* Progress is driven by the server's per-DOT callback where the platform
     supports streaming; the browser only needs to keep the clock moving. */

  const readFile = useCallback(
    async (candidate: File) => {
      setError(null);
      setPhase('reading');
      setResponse(null);
      setSelected(null);
      try {
        const text = await candidate.text();
        const parsed = parseCsv(text);
        const column = findDotColumn(parsed.headers, parsed.rows);

        if (column === null) {
          const docket = hasDocketColumn(parsed.headers);
          throw new Error(
            docket
              ? 'That file looks like it contains MC/MX docket numbers, not USDOT numbers. FMCSA docket numbers are a different identifier — add a column with the carrier’s USDOT number.'
              : 'No USDOT column found. Add a column named DOT, DOT Number or USDOT and try again.',
          );
        }

        const values = parsed.rows.map((row) => row[column] ?? '');
        const nonEmpty = values.filter((value) => value.trim() !== '');
        const valid = nonEmpty.filter((value) => parseDot(value) !== null);

        if (valid.length === 0) {
          throw new Error('No row in that column could be read as a USDOT number (digits only, up to 8 digits).');
        }
        if (parsed.rows.length > maxRows) {
          throw new Error(
            `That file has ${parsed.rows.length.toLocaleString('en-US')} rows; this deployment handles ${maxRows.toLocaleString(
              'en-US',
            )} per run. Split the file and enrich it in batches.`,
          );
        }

        const duplicates = valid.length - new Set(valid.map((value) => parseDot(value))).size;
        setUpload({
          headers: parsed.headers,
          dots: nonEmpty,
          columnName: parsed.headers[column] ?? `Column ${column + 1}`,
          duplicates: Math.max(0, duplicates),
          blank: values.length - nonEmpty.length,
          docketWarning: hasDocketColumn(parsed.headers),
        });
        setFile(candidate);
        setPhase('idle');
      } catch (err) {
        setUpload(null);
        setFile(null);
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Could not read that file.');
      }
    },
    [maxRows],
  );

  const runEnrichment = useCallback(async () => {
    if (!upload) return;
    setError(null);
    setResponse(null);
    setSelected(null);
    setPhase('enriching');
    setElapsed(0);
    setProgress({ done: 0, total: upload.dots.length, startedAt: Date.now() });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // The API streams newline-delimited JSON: progress events first, then the
      // final payload. Progress therefore reflects real lookups completing.
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson, application/json',
        },
        body: JSON.stringify({ dots: upload.dots }),
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') ?? '';

      if (!res.ok || contentType.includes('application/json')) {
        const payload = (await res.json()) as EnrichResponse | { error: string };
        if (!res.ok || 'error' in payload) {
          throw new Error('error' in payload ? payload.error : `Enrichment failed (HTTP ${res.status})`);
        }
        setResponse(payload);
        setProgress((prev) => ({ ...prev, done: payload.results.length, total: payload.results.length }));
        setPhase('done');
        return;
      }

      if (!res.body) throw new Error('The server returned an empty response.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let settled = false;

      while (!settled) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line || line.startsWith(':')) continue;

          let event: { type?: string; done?: number; total?: number; payload?: EnrichResponse; message?: string };
          try {
            event = JSON.parse(line);
          } catch {
            continue; // partial line, wait for the rest
          }

          if (event.type === 'progress') {
            setProgress((prev) => ({ ...prev, done: event.done ?? prev.done, total: event.total ?? prev.total }));
          } else if (event.type === 'result' && event.payload) {
            setResponse(event.payload);
            setProgress((prev) => ({ ...prev, done: event.payload!.results.length, total: event.payload!.results.length }));
            setPhase('done');
            settled = true;
          } else if (event.type === 'error') {
            throw new Error(event.message ?? 'Enrichment failed.');
          }
        }
      }

      if (!settled) throw new Error('The run ended before a result arrived. Please try again.');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Run cancelled. No partial file was produced.');
      } else {
        setError(err instanceof Error ? err.message : 'Enrichment failed.');
      }
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }, [upload]);

  const download = useCallback(() => {
    if (rows.length === 0) return;
    const csv = buildCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportFilename();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [rows]);

  const downloadSample = useCallback(() => {
    const blob = new Blob([`\uFEFF${SAMPLE_CSV}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'dot-enricher-sample.csv';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, []);

  const retryRows = useMemo(() => rows.filter((row) => row.status === 'retry'), [rows]);
  const batchIncomplete = phase === 'done' && (response?.meta.complete === false || retryRows.length > 0);

  const retryIncomplete = useCallback(async () => {
    if (!response || retryRows.length === 0) return;
    const retryDots = retryRows.map((row) => row.dot);
    setError(null);
    setSelected(null);
    setPhase('enriching');
    setElapsed(0);
    setProgress({ done: 0, total: retryDots.length, startedAt: Date.now() });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ dots: retryDots }),
        signal: controller.signal,
      });
      const payload = (await res.json()) as EnrichResponse | { error: string };
      if (!res.ok || 'error' in payload) {
        throw new Error('error' in payload ? payload.error : `Retry failed (HTTP ${res.status})`);
      }

      const byDot = new Map(payload.results.map((item) => [item.dot, item]));
      const merged = response.results.map((existing) =>
        existing.status === 'retry' && byDot.has(existing.dot) ? byDot.get(existing.dot)! : existing,
      );
      const remainingRetry = merged.filter((row) => row.status === 'retry').length;
      setResponse({
        results: merged,
        meta: {
          ...payload.meta,
          requested: response.meta.requested,
          returned: merged.length,
          pendingRetryCount: remainingRetry,
          complete: remainingRetry === 0 && payload.meta.motusOk,
        },
      });
      setProgress((prev) => ({ ...prev, done: retryDots.length, total: retryDots.length }));
      setPhase('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Retry cancelled.');
      } else {
        setError(err instanceof Error ? err.message : 'Retry failed.');
      }
      setPhase('done');
    } finally {
      abortRef.current = null;
    }
  }, [response, retryRows]);

  const busy = phase === 'enriching' || phase === 'reading';
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const keyMissing = status ? !status.fmcsa.configured : !serverHasKey;

  return (
    <>
      <header className="masthead">
        <div className="masthead__inner">
          <div className="brand-mark">
            <TruckIcon size={28} />
          </div>
          <div className="brand-text">
            <span className="brand-text__eyebrow">GoshBuzz</span>
            <span className="brand-text__name">Free Trucking Leads</span>
          </div>
          <div className="masthead__spacer" />
          <a href="/" style={{ color: "white", marginRight: 16 }}>Home</a>
          <span className="pill">
            {busy ? <span className="dot-live" /> : batchIncomplete ? <AlertIcon size={13} /> : <CheckIcon size={13} />}
            {busy ? 'Working' : batchIncomplete ? `Incomplete (${retryRows.length} pending)` : phase === 'done' ? 'Complete' : 'Ready'}
          </span>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        <div className="tabs__inner">
          <button
            type="button"
            className="tab"
            aria-current={tab === 'leads' ? 'page' : undefined}
            onClick={() => setTab('leads')}
          >
            Preview leads
          </button>
          <button
            type="button"
            className="tab"
            aria-current={tab === 'enrich' ? 'page' : undefined}
            onClick={() => setTab('enrich')}
          >
            CSV enrichment
          </button>
        </div>
      </nav>

      <main className="page">
        {tab === 'leads' ? <PreviewLeads maxRows={maxRows} mockMode={mockMode} /> : null}
        {tab === 'enrich' ? (
          <>
            {mockMode ? (
              <div className="notice notice--warn">
                <AlertIcon />
                <span>
                  <strong>Demo mode.</strong> MOCK_FMCSA=1 is set, so carrier records are generated locally instead of read from
                  FMCSA. Unset it in Vercel to use the live API.
                </span>
              </div>
            ) : null}

            {keyMissing ? (
              <div className="notice notice--error">
                <AlertIcon />
                <span>
                  <strong>FMCSA webKey not detected.</strong> Set <code className="inline">FMCSA_WEB_KEY</code> (or{' '}
                  <code className="inline">FMCSA_API_KEY</code>) in your Vercel project&apos;s environment variables and redeploy.
                  Insurance and census columns still work without a key, because those datasets are public.
                </span>
              </div>
            ) : null}

            {/* ---------------------------------------------------------------- */}
            {/* Upload                                                            */}
            {/* ---------------------------------------------------------------- */}
            <section className="card" aria-labelledby="enrich-heading">
              <div className="card__body">
                <div className="card__head">
                  <div>
                    <p className="eyebrow">Enrich your list</p>
                    <h1 id="enrich-heading" className="title-lg">
                      From DOT numbers to carrier details
                    </h1>
                  </div>
                  <p className="small muted" style={{ textAlign: 'right', maxWidth: 260 }}>
                    Upload a CSV, review the results, and download your enriched list.
                  </p>
                </div>

                <div className="enrich-grid">
                  <div>
                    <FileDrop
                      file={file}
                      onFile={(next) => {
                        if (next) void readFile(next);
                        else {
                          setFile(null);
                          setUpload(null);
                          setResponse(null);
                          setPhase('idle');
                          setError(null);
                        }
                      }}
                      onError={(message) => {
                        setError(message);
                        setPhase('error');
                      }}
                      maxBytes={maxFileBytes}
                      maxRows={maxRows}
                      disabled={busy}
                    />

                    {upload ? (
                      <p className="xsmall muted" style={{ marginTop: 10 }}>
                        Detected <strong>{upload.columnName}</strong> as the USDOT column ·{' '}
                        {upload.dots.length.toLocaleString('en-US')} values
                        {upload.duplicates > 0 ? ` · ${upload.duplicates} duplicate${upload.duplicates === 1 ? '' : 's'} will be looked up once` : ''}
                        {upload.blank > 0 ? ` · ${upload.blank} blank row${upload.blank === 1 ? '' : 's'} ignored` : ''}
                      </p>
                    ) : null}

                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => void runEnrichment()}
                        disabled={!upload || busy}
                      >
                        {phase === 'enriching' ? (
                          <>
                            <span className="spinner" /> Enriching…
                          </>
                    ) : (
                      'Enrich DOT numbers'
                    )}
                  </button>
                  <button type="button" className="linkish" onClick={downloadSample}>
                    Download sample CSV
                  </button>
                  {phase === 'enriching' ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => abortRef.current?.abort()}
                      style={{ color: 'var(--red-600)' }}
                    >
                      Cancel run
                    </button>
                  ) : null}
                  {batchIncomplete && retryRows.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void retryIncomplete()}
                    >
                      <RefreshIcon size={14} /> Retry {retryRows.length.toLocaleString('en-US')} incomplete
                    </button>
                  ) : null}
                  {phase === 'done' && rows.length > 0 ? (
                    <button type="button" className="btn btn--dark btn--sm" onClick={download}>
                      <DownloadIcon /> {batchIncomplete ? 'Download partial CSV' : 'Download enriched CSV'}
                    </button>
                  ) : null}
                </div>

                {error ? (
                  <div className="notice notice--error" style={{ marginTop: 14 }} role="alert">
                    <AlertIcon />
                    <span>{error}</span>
                  </div>
                ) : null}
              </div>

              {/* Sidebar: exactly what the export contains */}
              <aside aria-label="What the enriched export contains">
                <p className="eyebrow" style={{ color: 'var(--navy-500)' }}>
                  Your enriched export
                </p>
                <h2 style={{ fontSize: 19, marginBottom: 14 }}>Contact details and current insurance</h2>

                <div className="sidebar-section">
                  <h4>Contact details and current insurance</h4>
                  <p>
                    Contact name, business name, phone, email, record dates, and the latest current policy&apos;s number,
                    effective date, and expiration date.
                  </p>
                </div>
                <div className="sidebar-section">
                  <h4>Created &amp; last activity</h4>
                  <p>
                    FMCSA record creation and last update, shown in EDT (UTC−04:00). Registration dates come from the Motor
                    Carrier Census File.
                  </p>
                </div>
                <div className="sidebar-section">
                  <h4>Missing information</h4>
                  <p>
                    Unavailable fields stay blank and are listed in Notes. Expiration is included only when FMCSA provides it;
                    it is never estimated from the effective or cancellation date.
                  </p>
                </div>
                <div className="sidebar-section">
                  <h4>Every uploaded row stays in your export</h4>
                  <p>
                    Repeated DOT numbers share a lookup. Invalid or failed lookups remain visible in the download with a status,
                    so the row count always matches what you uploaded.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Progress                                                          */}
        {/* ---------------------------------------------------------------- */}
        {phase === 'enriching' || phase === 'done' || phase === 'error' ? (
          <section className="card card--gold" aria-labelledby="progress-heading">
            <div className="card__body">
              <div className="card__head" style={{ marginBottom: 10 }}>
                <div>
                  <p className="eyebrow eyebrow--gold">Enrichment progress</p>
                  <h2 id="progress-heading" style={{ fontSize: 17 }}>
                    {phase === 'enriching'
                      ? `Checking ${progress.total.toLocaleString('en-US')} DOT numbers…`
                      : batchIncomplete
                        ? `Batch incomplete — ${retryRows.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} record(s) still waiting for MOTUS / FMCSA enrichment.`
                        : phase === 'done'
                          ? `Checked ${rows.length.toLocaleString('en-US')} uploaded rows.`
                          : 'Run stopped.'}
                  </h2>
                </div>
                <p className="xsmall mono muted">
                  {phase === 'enriching'
                    ? `${progress.done} / ${progress.total} DOT NUMBERS · ${(elapsed / 1000).toFixed(1)}s`
                    : response
                      ? `${rows.length} / ${response.meta.requested} DOT NUMBERS · ${(response.meta.elapsedMs / 1000).toFixed(1)}s`
                      : ''}
                </p>
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={phase === 'enriching' ? percent : 100}
                aria-label="Enrichment progress"
              >
                <div
                  className={`progress__bar${phase === 'error' ? ' progress__bar--gold' : ''}`}
                  style={{ width: `${phase === 'enriching' ? Math.max(4, percent) : 100}%` }}
                />
              </div>
              <div className="progress__meta">
                <span>
                  {phase === 'enriching'
                    ? 'Contacting FMCSA QCMobile, the Motor Carrier Census File and Motus insurance filings.'
                    : `Sources: QCMobile carrier records, Motor Carrier Census File, Motus Insur + InsHist.`}
                </span>
                <span className="mono">{phase === 'enriching' ? `${percent}%` : '100%'}</span>
              </div>
            </div>
          </section>
        ) : null}

        {response?.meta.diagnosis && response.meta.diagnosis.cause !== 'none' ? (
          <div
            className={`notice notice--${
              response.meta.diagnosis.severity === 'error'
                ? 'error'
                : response.meta.diagnosis.severity === 'warn'
                  ? 'warn'
                  : 'info'
            }`}
            role={response.meta.diagnosis.severity === 'error' ? 'alert' : undefined}
          >
            <AlertIcon />
            <span>
              <strong>{response.meta.diagnosis.title}.</strong> {response.meta.diagnosis.detail}
              {response.meta.diagnosis.action ? (
                <>
                  {' '}
                  <span style={{ display: 'block', marginTop: 4 }}>
                    <strong>Next step:</strong> {response.meta.diagnosis.action}
                  </span>
                </>
              ) : null}
              {response.meta.diagnosis.owner === 'fmcsa' ? (
                <span style={{ display: 'block', marginTop: 4 }} className="xsmall">
                  Nothing in your file caused this.
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {response?.meta.warnings.length ? (
          <div className="notice notice--warn">
            <AlertIcon />
            <span>
              {response.meta.warnings.map((warning, index) => (
                <span key={index} style={{ display: 'block' }}>
                  {warning}
                </span>
              ))}
            </span>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Stats                                                             */}
        {/* ---------------------------------------------------------------- */}
        {rows.length > 0 ? (
          <section className="stat-grid" aria-label="Run summary">
            <div className="stat">
              <p className="stat__label">Uploaded rows</p>
              <p className="stat__value">{summary.uploaded.toLocaleString('en-US')}</p>
              <p className="stat__sub">{new Set(rows.map((r) => r.dot)).size.toLocaleString('en-US')} unique DOT numbers</p>
            </div>
            <div className="stat stat--teal">
              <p className="stat__label">Enriched</p>
              <p className="stat__value">{summary.enriched.toLocaleString('en-US')}</p>
              <p className="stat__sub">Contact and policy data complete</p>
            </div>
            <div className="stat stat--gold">
              <p className="stat__label">Missing fields</p>
              <p className="stat__value">{summary.missingFields.toLocaleString('en-US')}</p>
              <p className="stat__sub">
                {rows.filter((r) => r.missing.length > 0).length} rows with blanks
              </p>
            </div>
            <div className="stat">
              <p className="stat__label">Needs retry or correction</p>
              <p className="stat__value">{summary.needsAttention.toLocaleString('en-US')}</p>
              <p className="stat__sub">Failed, invalid, unmatched or unreadable email</p>
            </div>
          </section>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Results                                                           */}
        {/* ---------------------------------------------------------------- */}
        {rows.length > 0 ? (
          <section className="card" aria-labelledby="results-heading">
            <div className="card__body">
              <div className="card__head">
                <div>
                  <p className="eyebrow">Review</p>
                  <h2 id="results-heading" style={{ fontSize: 17 }}>
                    Preview — the download has {REQUIRED_COLUMNS.length} required columns plus optional detail
                  </h2>
                </div>
                <div className="row">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadStatus(true)} disabled={probing}>
                    {probing ? <span className="spinner spinner--dark" /> : <RefreshIcon size={14} />} Re-check API
                  </button>
                  <button type="button" className="btn btn--primary btn--sm" onClick={download}>
                    <DownloadIcon /> Download CSV
                  </button>
                </div>
              </div>

              <ResultsTable rows={rows} selected={selected} onSelect={setSelected} />
            </div>
            {selected ? <RowDetail row={selected} onClose={() => setSelected(null)} /> : null}
          </section>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Empty state / API connection                                      */}
        {/* ---------------------------------------------------------------- */}
        {rows.length === 0 && phase !== 'enriching' ? (
          <section className="card card--navy" aria-labelledby="connection-heading">
            <div className="card__body">
              <div className="card__head">
                <div>
                  <p className="eyebrow eyebrow--navy">API connection</p>
                  <h2 id="connection-heading" style={{ fontSize: 17 }}>
                    Data sources
                  </h2>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void loadStatus(true)}
                  disabled={probing}
                >
                  {probing ? <span className="spinner spinner--dark" /> : <RefreshIcon size={14} />} Test live connection
                </button>
              </div>

              {statusError ? (
                <div className="notice notice--error">
                  <AlertIcon />
                  <span>{statusError}</span>
                </div>
              ) : null}

              {status?.probe?.diagnosis ? (
                <div
                  className={`notice notice--${
                    status.probe.diagnosis.code === 'ok'
                      ? 'info'
                      : status.probe.diagnosis.code === 'key_rejected' || status.probe.diagnosis.code === 'no_key'
                        ? 'error'
                        : 'warn'
                  }`}
                  style={{ marginBottom: 14 }}
                >
                  <AlertIcon />
                  <span>
                    <strong>Live check:</strong> {status.probe.diagnosis.message}
                  </span>
                </div>
              ) : null}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
                <div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h3 style={{ fontSize: 14.5 }}>FMCSA QCMobile</h3>
                    <span className={`pill ${status?.fmcsa.configured ? 'pill--ok' : 'pill--bad'}`}>
                      {status?.fmcsa.configured ? 'Key detected' : 'No key'}
                    </span>
                  </div>
                  <p className="xsmall muted" style={{ marginTop: 4 }}>
                    Carrier registration record: legal/DBA name, phone, email, officer, added date and MCS-150 date.
                  </p>
                  <dl className="kv xsmall" style={{ marginTop: 8, gridTemplateColumns: '110px minmax(0,1fr)' }}>
                    <dt>Env var</dt>
                    <dd className="mono">{status?.fmcsa.envVar ?? '—'}</dd>
                    <dt>Key</dt>
                    <dd className="mono">{status?.fmcsa.masked ?? 'not set'}</dd>
                    <dt>Base URL</dt>
                    <dd className="mono">{status?.fmcsa.baseUrl ?? '—'}</dd>
                    {status?.probe?.fmcsa ? (
                      <>
                        <dt>Last probe</dt>
                        <dd>
                          {status.probe.fmcsa.ok ? 'OK' : 'Failed'} · {status.probe.fmcsa.latencyMs} ms — {status.probe.fmcsa.message}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>

                <div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h3 style={{ fontSize: 14.5 }}>Motus insurance &amp; census</h3>
                    <span className={`pill ${status ? 'pill--ok' : 'pill--neutral'}`}>
                      {status?.motus.configured ? 'Public data' : 'Disabled'}
                    </span>
                  </div>
                  <p className="xsmall muted" style={{ marginTop: 4 }}>
                    Motor Carrier Census File (email + added date) and Motus Insur/InsHist (policy number, effective and
                    cancellation dates). Public DOT data — no key required.
                  </p>
                  <dl className="kv xsmall" style={{ marginTop: 8, gridTemplateColumns: '110px minmax(0,1fr)' }}>
                    <dt>Datasets</dt>
                    <dd className="mono">
                      {status ? Object.values(status.motus.datasets).join(', ') : '—'}
                    </dd>
                    <dt>App token</dt>
                    <dd className="mono">{status?.motus.envVar ?? 'optional, not set'}</dd>
                    {status?.probe?.motus ? (
                      <>
                        <dt>Last probe</dt>
                        <dd>
                          {status.probe.motus.ok ? 'OK' : 'Failed'} · {status.probe.motus.latencyMs} ms — {status.probe.motus.message}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              </div>

              <div className="notice notice--info" style={{ marginTop: 16 }}>
                <ShieldIcon />
                <span>
                  The FMCSA webKey is read on the server and never reaches the browser. Only DOT numbers are uploaded, so your
                  carrier list is not stored anywhere by this app.
                </span>
              </div>

              {mockMode ? (
                <div className="notice notice--info" style={{ marginTop: 10 }}>
                  <InfoIcon />
                  <span>Demo mode is on. Download the sample CSV and press Enrich to see a full run without live keys.</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* Footer note about the 10 requested columns */}
        <p className="xsmall muted" style={{ textAlign: 'center', marginTop: 4 }}>
          Export columns: {REQUIRED_COLUMNS.map((c) => c.header).join(' · ')}
        </p>
          </>
        ) : null}
      </main>
    </>
  );
}

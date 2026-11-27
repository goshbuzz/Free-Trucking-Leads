'use client';

import { formatEastern, isActivePolicy } from '@/lib/normalize';
import { statusLabel } from '@/lib/export';
import type { CarrierEnrichment } from '@/lib/types';

interface RowDetailProps {
  row: CarrierEnrichment;
  onClose: () => void;
}

const LOOKUP_LABEL: Record<string, string> = {
  ok: 'responded',
  not_found: 'no record',
  error: 'failed',
  skipped: 'not queried',
  disabled: 'key missing',
};

/**
 * "Why is this cell blank?" — the detail panel answers that question per row,
 * which matters because a factoring list is only as good as its weakest row.
 */
export function RowDetail({ row, onClose }: RowDetailProps) {
  const active = row.policies.filter((policy) => isActivePolicy(policy));

  return (
    <div className="drawer">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <p className="eyebrow eyebrow--navy">Row detail · DOT {row.dot}</p>
          <h3 style={{ fontSize: 17 }}>{row.legalName ?? 'No carrier name on file'}</h3>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 22,
        }}
      >
        <div>
          <h4 className="small" style={{ marginBottom: 8 }}>
            Contact & registration
          </h4>
          <dl className="kv">
            <dt>Enrichment status</dt>
            <dd>{statusLabel(row.status)}</dd>
            <dt>Contact name</dt>
            <dd>{row.contactName ?? '—'}</dd>
            <dt>DBA</dt>
            <dd>{row.dbaName ?? '—'}</dd>
            <dt>Phone</dt>
            <dd>
              {row.phone ?? '—'} {row.phoneE164 ? <span className="muted xsmall mono">({row.phoneE164})</span> : null}
            </dd>
            <dt>Email</dt>
            <dd>
              {row.email ?? '—'}
              {row.needsCorrection ? <span className="pill pill--warn" style={{ marginLeft: 8 }}>needs correction</span> : null}
            </dd>
            <dt>Created (EDT)</dt>
            <dd className="mono xsmall">{row.createdEdt ?? '—'}</dd>
            <dt>MCS-150 update</dt>
            <dd className="mono xsmall">{row.mcs150Date ?? '—'}</dd>
            <dt>USDOT status</dt>
            <dd>{row.usdotStatus ?? '—'}</dd>
            <dt>Physical address</dt>
            <dd>{[row.street, row.city, row.state, row.zip].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Fleet</dt>
            <dd>{row.powerUnits !== null ? `${row.powerUnits} power units` : '—'}{row.drivers !== null ? ` · ${row.drivers} drivers` : ''}</dd>
            <dt>Provenance</dt>
            <dd>
              {(['fmcsa', 'census', 'insurance'] as const).map((key) => (
                <span key={key} className="xsmall" style={{ marginRight: 12 }}>
                  <strong style={{ textTransform: 'capitalize' }}>{key === 'fmcsa' ? 'QCMobile' : key}:</strong>{' '}
                  {LOOKUP_LABEL[row.lookup[key]] ?? row.lookup[key]}
                </span>
              ))}
            </dd>
            {row.elapsedMs ? (
              <>
                <dt>Lookup time</dt>
                <dd className="mono xsmall">{row.elapsedMs} ms</dd>
              </>
            ) : null}
          </dl>
        </div>

        <div>
          <h4 className="small" style={{ marginBottom: 8 }}>
            Insurance filings ({row.policies.length})
          </h4>
          {row.policies.length === 0 ? (
            <p className="small muted">
              No insurance filing is published for this carrier. FMCSA only shows coverages that an insurer has filed.
            </p>
          ) : (
            <div className="stack">
              {row.policies.map((policy, index) => (
                <div
                  key={`${policy.policyNumber}-${policy.effectiveDate}-${index}`}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    background: '#fff',
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong className="small">
                      {policy.policyNumber ?? 'No policy number'}
                    </strong>
                    <span className={`pill ${policy.active ? 'pill--ok' : 'pill--neutral'}`}>
                      {policy.active ? 'On file' : 'Terminated'}
                    </span>
                  </div>
                  <p className="xsmall muted" style={{ marginTop: 2 }}>
                    {policy.kindLabel} · {policy.formCode ?? 'form n/a'} · {policy.insurer ?? 'insurer not published'}
                    {policy.coverage ? ` · $${policy.coverage.toLocaleString('en-US')}` : ''}
                  </p>
                  <p className="xsmall muted">
                    Effective {policy.effectiveDate ?? '—'} · Expiration {policy.cancellationDate ?? 'not on file'} ·{' '}
                    {policy.source === 'motus-insur' ? 'Motus Insur' : 'Motus InsHist'}
                  </p>
                </div>
              ))}
              <p className="xsmall muted">
                {active.length} active filing{active.length === 1 ? '' : 's'} · the export uses the highest-ranked active
                BIPD policy.
              </p>
            </div>
          )}

          {row.notes.length > 0 ? (
            <>
              <h4 className="small" style={{ margin: '16px 0 8px' }}>
                Notes
              </h4>
              <ul className="xsmall muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {row.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="xsmall muted" style={{ marginTop: 14 }}>
              Every required field was supplied by FMCSA. Created timestamp shown in Eastern Time:{' '}
              {formatEastern(row.mcs150Date) ?? '—'} is the last MCS-150 filing.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

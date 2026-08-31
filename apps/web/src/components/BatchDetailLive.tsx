'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  URL_PAGE_SIZE,
  isBatchTerminal,
  progressPercent,
  type BatchDetail,
  type StreamEvent,
  type UrlCheck,
  type UrlStatus,
} from '@buhc/shared';
import { cancelBatch, retryFailed } from '@/lib/client';
import { useStream } from '@/lib/useStream';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { ConnectionPill } from './ConnectionPill';

function mergeUrl(urls: UrlCheck[], incoming: UrlCheck): UrlCheck[] {
  let replaced = false;
  const next = urls.map((u) => {
    if (u.id !== incoming.id) return u;
    replaced = true;
    // Out-of-order frames must never move a row backwards.
    return incoming.updatedAt >= u.updatedAt ? incoming : u;
  });
  return replaced ? next : [...next, incoming];
}

const FILTERS: { value: UrlStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function BatchDetailLive({ initial }: { initial: BatchDetail }) {
  const [batch, setBatch] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<UrlStatus | 'all'>('all');
  // The rows are already in memory (the live merge needs them all); this only bounds
  // how many the DOM holds, which is what actually costs on a 500-URL batch.
  const [visible, setVisible] = useState(URL_PAGE_SIZE);

  const onEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'snapshot') {
      setBatch(event.batch);
    } else if (event.type === 'url') {
      setBatch((prev) => ({ ...prev, urls: mergeUrl(prev.urls, event.url) }));
    } else if (event.type === 'batch') {
      const summary = event.batch;
      setBatch((prev) => ({ ...prev, ...summary, urls: prev.urls }));
    }
  }, []);

  const status = useStream(`/api/batches/${initial.id}/stream`, onEvent);

  const filtered = useMemo(
    () => (filter === 'all' ? batch.urls : batch.urls.filter((u) => u.status === filter)),
    [batch.urls, filter],
  );
  const shown = filtered.slice(0, visible);
  const hasMore = filtered.length > shown.length;

  const sentinelRef = useInfiniteScroll<HTMLTableRowElement>(
    () => setVisible((v) => v + URL_PAGE_SIZE),
    hasMore,
  );

  async function run(action: () => Promise<{ batch: BatchDetail }>) {
    setBusy(true);
    setActionError(null);
    try {
      setBatch((await action()).batch);
    } catch (err) {
      // Without this the rejection went nowhere and the button looked inert.
      setActionError(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  const retryable = batch.counts.failed + batch.counts.cancelled;
  const percent = progressPercent(batch.counts);

  return (
    <section className="card">
      <div className="row between">
        <div>
          <Link href="/" className="link small">
            ← All batches
          </Link>
          <h2 style={{ marginTop: 6 }}>{batch.name}</h2>
        </div>
        <div className="row">
          <span className={`pill status-${batch.status}`}>{batch.status}</span>
          <ConnectionPill status={status} />
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <b>{batch.counts.total}</b>
          <span>Total</span>
        </div>
        <div className="stat ok">
          <b>{batch.counts.success}</b>
          <span>Success</span>
        </div>
        <div className="stat bad">
          <b>{batch.counts.failed}</b>
          <span>Failed</span>
        </div>
        <div className="stat pending">
          <b>{batch.counts.pending}</b>
          <span>Pending</span>
        </div>
        <div className="stat">
          <b>{batch.counts.cancelled}</b>
          <span>Cancelled</span>
        </div>
      </div>

      <div
        className="progress"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="muted small">{percent}% complete</div>

      <div className="row">
        <button
          className="btn danger"
          disabled={busy || isBatchTerminal(batch.status)}
          onClick={() => void run(() => cancelBatch(batch.id))}
        >
          Cancel batch
        </button>
        <button
          className="btn"
          disabled={busy || retryable === 0}
          onClick={() => void run(() => retryFailed(batch.id))}
        >
          Retry failed ({retryable})
        </button>
      </div>

      {actionError && (
        <p className="error small" role="alert">
          {actionError}
        </p>
      )}

      <div className="row between">
        <div className="segmented" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="segment"
              aria-pressed={filter === f.value}
              onClick={() => {
                setFilter(f.value);
                setVisible(URL_PAGE_SIZE);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="muted small">
          Showing {shown.length} of {filtered.length}
        </span>
      </div>

      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Time</th>
              <th>Title</th>
              <th>Tries</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id}>
                <td className="mono truncate" title={u.finalUrl ?? u.url}>
                  {u.url}
                </td>
                <td>
                  <span className={`pill status-${u.status}`}>{u.status}</span>
                </td>
                <td className="num mono">{u.httpStatus ?? '—'}</td>
                <td className="num mono">
                  {u.responseTimeMs != null ? `${u.responseTimeMs} ms` : '—'}
                </td>
                <td className="truncate" title={u.error ?? u.title ?? ''}>
                  {u.title ?? (u.error ? <span className="error">{u.error}</span> : '—')}
                </td>
                <td className="num mono">{u.attempts}</td>
              </tr>
            ))}
            {hasMore && (
              <tr ref={sentinelRef}>
                <td colSpan={6} className="muted small" style={{ textAlign: 'center' }}>
                  Loading {Math.min(URL_PAGE_SIZE, filtered.length - shown.length)} more…
                </td>
              </tr>
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <p className="empty">No URLs with this status.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

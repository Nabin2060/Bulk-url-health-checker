'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  isBatchTerminal,
  progressPercent,
  type BatchDetail,
  type StreamEvent,
  type UrlCheck,
} from '@buhc/shared';
import { cancelBatch, retryFailed } from '@/lib/client';
import { useStream } from '@/lib/useStream';
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

export function BatchDetailLive({ initial }: { initial: BatchDetail }) {
  const [batch, setBatch] = useState(initial);
  const [busy, setBusy] = useState(false);

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

  async function run(action: () => Promise<{ batch: BatchDetail }>) {
    setBusy(true);
    try {
      setBatch((await action()).batch);
    } finally {
      setBusy(false);
    }
  }

  const failedCount = batch.counts.failed + batch.counts.cancelled;
  const percent = progressPercent(batch.counts);

  return (
    <section className="card">
      <div className="row between">
        <div>
          <Link href="/" className="muted small">
            ← all batches
          </Link>
          <h2>{batch.name}</h2>
        </div>
        <ConnectionPill status={status} />
      </div>

      <div className="row">
        <span className={`pill status-${batch.status}`}>{batch.status}</span>
        <span className="muted small">
          {batch.counts.success} ok · {batch.counts.failed} failed · {batch.counts.pending} pending ·{' '}
          {batch.counts.cancelled} cancelled
        </span>
      </div>

      <div className="progress">
        <div className="bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="muted small">{percent}% complete</div>

      <div className="row">
        <button
          className="btn"
          disabled={busy || isBatchTerminal(batch.status)}
          onClick={() => void run(() => cancelBatch(batch.id))}
        >
          Cancel batch
        </button>
        <button
          className="btn"
          disabled={busy || failedCount === 0}
          onClick={() => void run(() => retryFailed(batch.id))}
        >
          Retry failed ({failedCount})
        </button>
      </div>

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
          {batch.urls.map((u) => (
            <tr key={u.id}>
              <td className="mono truncate" title={u.finalUrl ?? u.url}>
                {u.url}
              </td>
              <td>
                <span className={`pill status-${u.status}`}>{u.status}</span>
              </td>
              <td className="mono">{u.httpStatus ?? '—'}</td>
              <td className="mono">{u.responseTimeMs != null ? `${u.responseTimeMs} ms` : '—'}</td>
              <td className="truncate" title={u.error ?? u.title ?? ''}>
                {u.title ?? (u.error ? <span className="error">{u.error}</span> : '—')}
              </td>
              <td className="mono">{u.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

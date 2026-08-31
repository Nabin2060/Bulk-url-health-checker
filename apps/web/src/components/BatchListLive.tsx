'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { progressPercent, type BatchSummary, type StreamEvent } from '@buhc/shared';
import { useStream } from '@/lib/useStream';
import { ConnectionPill } from './ConnectionPill';
import { formatTimestamp } from '@/lib/format';

function sorted(batches: BatchSummary[]): BatchSummary[] {
  return [...batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function BatchListLive({ initial }: { initial: BatchSummary[] }) {
  const [batches, setBatches] = useState(sorted(initial));

  const onEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'batch-list') {
      setBatches(sorted(event.batches));
    } else if (event.type === 'batch') {
      const incoming = event.batch;
      setBatches((prev) =>
        sorted([incoming, ...prev.filter((b) => b.id !== incoming.id)]),
      );
    }
  }, []);

  const status = useStream('/api/batches/stream', onEvent);

  return (
    <section className="card">
      <div className="row between">
        <h2>Batches</h2>
        <ConnectionPill status={status} />
      </div>

      {batches.length === 0 && <p className="muted">No batches yet.</p>}

      <div className="list">
        {batches.map((batch) => (
          <Link key={batch.id} href={`/batches/${batch.id}`} className="listItem">
            <div>
              <strong>{batch.name}</strong>
              <div className="muted small">{formatTimestamp(batch.createdAt)}</div>
            </div>
            <div className="row">
              <span className={`pill status-${batch.status}`}>{batch.status}</span>
              <span className="muted small">
                {batch.counts.total - batch.counts.pending}/{batch.counts.total} ·{' '}
                {progressPercent(batch.counts)}%
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

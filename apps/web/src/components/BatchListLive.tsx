'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import {
  DEFAULT_PAGE_SIZE,
  progressPercent,
  type BatchListPage,
  type BatchSummary,
  type StreamEvent,
} from '@buhc/shared';
import { fetchBatchPage } from '@/lib/client';
import { useStream } from '@/lib/useStream';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { ConnectionPill } from './ConnectionPill';
import { formatTimestamp } from '@/lib/format';

function sorted(batches: BatchSummary[]): BatchSummary[] {
  return [...batches].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

function upsert(list: BatchSummary[], incoming: BatchSummary): BatchSummary[] {
  return sorted([incoming, ...list.filter((b) => b.id !== incoming.id)]);
}

export function BatchListLive({ initial }: { initial: BatchListPage }) {
  const [batches, setBatches] = useState(() => sorted(initial.batches));
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const onEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'batch-list') {
      // Snapshot on (re)connect. It is only the FIRST page, so merge rather than
      // replace: pages the user already scrolled past must survive a reconnect.
      setBatches((prev) => {
        const fresh = new Map(event.page.batches.map((b) => [b.id, b]));
        const kept = prev.filter((b) => !fresh.has(b.id));
        return sorted([...event.page.batches, ...kept]);
      });
      return;
    }
    if (event.type !== 'batch') return;

    const incoming = event.batch;
    setBatches((prev) => {
      const known = prev.some((b) => b.id === incoming.id);
      // An unknown batch older than everything we hold belongs to a page we have not
      // loaded. Admitting it here would drop it in at the bottom, out of place; it
      // will arrive correctly when the user scrolls that far.
      if (!known && prev.length > 0 && incoming.createdAt < prev[prev.length - 1]!.createdAt) {
        return prev;
      }
      return upsert(prev, incoming);
    });
  }, []);

  const status = useStream('/api/batches/stream', onEvent);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !cursor) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchBatchPage(cursor, DEFAULT_PAGE_SIZE);
      // Dedupe on merge: a batch can arrive both by page and by a live event.
      setBatches((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        return sorted([...prev, ...page.batches.filter((b) => !seen.has(b.id))]);
      });
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load more');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor]);

  const sentinelRef = useInfiniteScroll<HTMLDivElement>(
    () => void loadMore(),
    Boolean(cursor) && !error,
  );

  return (
    <section className="card">
      <div className="row between">
        <h2>Batches</h2>
        <div className="row">
          <span className="muted small">
            {batches.length}
            {cursor ? '+' : ''} total
          </span>
          <ConnectionPill status={status} />
        </div>
      </div>

      {batches.length === 0 ? (
        <p className="empty">No batches yet — submit some URLs above.</p>
      ) : (
        <div className="list">
          {batches.map((batch) => {
            const percent = progressPercent(batch.counts);
            const done = batch.counts.total - batch.counts.pending;
            return (
              <Link key={batch.id} href={`/batches/${batch.id}`} className="listItem">
                <div className="grow">
                  <div className="name">{batch.name}</div>
                  <div className="muted small">{formatTimestamp(batch.createdAt)}</div>
                </div>
                <div className="row">
                  {batch.counts.failed > 0 && (
                    <span className="pill status-failed">{batch.counts.failed} failed</span>
                  )}
                  <span className={`pill status-${batch.status}`}>{batch.status}</span>
                  <span className="muted small mono">
                    {done}/{batch.counts.total}
                  </span>
                  <span className="miniBar" aria-hidden>
                    <span style={{ width: `${percent}%` }} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {error && (
        <div className="loadMore">
          <span className="error">{error}</span>
          <button type="button" className="btn" onClick={() => void loadMore()}>
            Retry
          </button>
        </div>
      )}

      {cursor && !error && (
        <>
          <div ref={sentinelRef} className="sentinel" aria-hidden />
          <div className="loadMore">
            {loading ? (
              <>
                <span className="spinner" aria-hidden />
                <span>Loading more…</span>
              </>
            ) : (
              // Reachable without JS-driven scrolling, and a keyboard-accessible fallback.
              <button type="button" className="btn" onClick={() => void loadMore()}>
                Load more
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

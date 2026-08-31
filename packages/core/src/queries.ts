import {
  DEFAULT_PAGE_SIZE,
  type BatchDetail,
  type BatchListPage,
  type BatchSummary,
  type UrlCheck,
  type UrlStatus,
} from '@buhc/shared';
import { query, withTransaction } from './db';

interface BatchRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  total: string;
  pending: string;
  success: string;
  failed: string;
  cancelled: string;
}

interface UrlRow {
  id: string;
  batch_id: string;
  url: string;
  status: string;
  http_status: number | null;
  response_time_ms: number | null;
  title: string | null;
  final_url: string | null;
  error: string | null;
  attempts: number;
  run_count: number;
  updated_at: Date;
}

const SUMMARY_SELECT = `
  SELECT b.id, b.name, b.status, b.created_at, b.updated_at,
         count(u.id)                                                  AS total,
         count(u.id) FILTER (WHERE u.status IN ('queued','running'))   AS pending,
         count(u.id) FILTER (WHERE u.status = 'success')               AS success,
         count(u.id) FILTER (WHERE u.status = 'failed')                AS failed,
         count(u.id) FILTER (WHERE u.status = 'cancelled')             AS cancelled
  FROM batches b
  LEFT JOIN urls u ON u.batch_id = b.id
`;

function toSummary(row: BatchRow): BatchSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status as BatchSummary['status'],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    counts: {
      total: Number(row.total),
      pending: Number(row.pending),
      success: Number(row.success),
      failed: Number(row.failed),
      cancelled: Number(row.cancelled),
    },
  };
}

function toUrl(row: UrlRow): UrlCheck {
  return {
    id: row.id,
    batchId: row.batch_id,
    url: row.url,
    status: row.status as UrlStatus,
    httpStatus: row.http_status,
    responseTimeMs: row.response_time_ms,
    title: row.title,
    finalUrl: row.final_url,
    error: row.error,
    attempts: row.attempts,
    runCount: row.run_count,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Keyset ("seek") pagination on (created_at, id). OFFSET would be wrong here: batches
 * are inserted while the user scrolls, so an offset-paged list would skip or repeat
 * rows. A cursor is anchored to a row, so new batches at the head never shift a page.
 */
function encodeCursor(row: { created_at: Date; id: string }): string {
  return `${row.created_at.toISOString()}|${row.id}`;
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf('|');
  if (sep <= 0) return null;
  const createdAt = cursor.slice(0, sep);
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !UUID_RE.test(id)) return null;
  return { createdAt, id };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listBatches(
  limit = DEFAULT_PAGE_SIZE,
  cursor?: string,
): Promise<BatchListPage> {
  const after = decodeCursor(cursor);
  // Fetch one extra row to learn whether another page exists, without a COUNT(*).
  const rows = await query<BatchRow>(
    `${SUMMARY_SELECT}
      WHERE ($2::timestamptz IS NULL OR (b.created_at, b.id) < ($2::timestamptz, $3::uuid))
      GROUP BY b.id
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $1`,
    [limit + 1, after?.createdAt ?? null, after?.id ?? null],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    batches: page.map(toSummary),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

export async function getBatchSummary(batchId: string): Promise<BatchSummary | null> {
  const rows = await query<BatchRow>(`${SUMMARY_SELECT} WHERE b.id = $1 GROUP BY b.id`, [batchId]);
  return rows[0] ? toSummary(rows[0]) : null;
}

export async function getBatchUrls(batchId: string): Promise<UrlCheck[]> {
  const rows = await query<UrlRow>(
    `SELECT * FROM urls WHERE batch_id = $1 ORDER BY position ASC, id ASC`,
    [batchId],
  );
  return rows.map(toUrl);
}

export async function getBatchDetail(batchId: string): Promise<BatchDetail | null> {
  const summary = await getBatchSummary(batchId);
  if (!summary) return null;
  return { ...summary, urls: await getBatchUrls(batchId) };
}

export async function getBatchIdForKey(key: string): Promise<string | null> {
  const rows = await query<{ batch_id: string }>(
    `SELECT batch_id FROM idempotency_keys WHERE key = $1`,
    [key],
  );
  return rows[0]?.batch_id ?? null;
}

/** Batch + URLs are committed before a single job is enqueued. */
export async function createBatch(
  name: string,
  urls: string[],
  idempotencyKey?: string,
): Promise<{ batchId: string; urls: UrlCheck[] }> {
  return withTransaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO batches (name, status) VALUES ($1, 'queued') RETURNING id`,
      [name],
    );
    const batchId = batch.rows[0]!.id;

    await client.query(
      `INSERT INTO urls (batch_id, url, position)
       SELECT $1, u.url, u.ord FROM unnest($2::text[]) WITH ORDINALITY AS u(url, ord)
       ON CONFLICT (batch_id, url) DO NOTHING`,
      [batchId, urls],
    );

    if (idempotencyKey) {
      await client.query(`INSERT INTO idempotency_keys (key, batch_id) VALUES ($1, $2)`, [
        idempotencyKey,
        batchId,
      ]);
    }

    const inserted = await client.query<UrlRow>(
      `SELECT * FROM urls WHERE batch_id = $1 ORDER BY position ASC, id ASC`,
      [batchId],
    );
    return { batchId, urls: inserted.rows.map(toUrl) };
  });
}

export async function getBatchStatus(batchId: string): Promise<string | null> {
  const rows = await query<{ status: string }>(`SELECT status FROM batches WHERE id = $1`, [batchId]);
  return rows[0]?.status ?? null;
}

/** Claims the URL for this attempt. Returns null if the row is no longer runnable (e.g. cancelled). */
export async function claimUrl(urlId: string, runCount: number): Promise<UrlCheck | null> {
  const rows = await query<UrlRow>(
    `UPDATE urls
        SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND run_count = $2 AND status IN ('queued', 'running')
        AND EXISTS (SELECT 1 FROM batches b WHERE b.id = urls.batch_id AND b.status IN ('queued','running'))
      RETURNING *`,
    [urlId, runCount],
  );
  return rows[0] ? toUrl(rows[0]) : null;
}

export interface UrlResult {
  status: Extract<UrlStatus, 'success' | 'failed'>;
  httpStatus: number | null;
  responseTimeMs: number | null;
  title: string | null;
  finalUrl: string | null;
  error: string | null;
}

/** Terminal write; ignored if the row moved on (cancelled or already re-run). */
export async function finishUrl(
  urlId: string,
  runCount: number,
  result: UrlResult,
): Promise<UrlCheck | null> {
  const rows = await query<UrlRow>(
    `UPDATE urls
        SET status = $3, http_status = $4, response_time_ms = $5, title = $6,
            final_url = $7, error = $8, updated_at = now()
      WHERE id = $1 AND run_count = $2 AND status = 'running'
      RETURNING *`,
    [
      urlId,
      runCount,
      result.status,
      result.httpStatus,
      result.responseTimeMs,
      result.title,
      result.finalUrl,
      result.error,
    ],
  );
  return rows[0] ? toUrl(rows[0]) : null;
}

export async function markBatchRunning(batchId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE batches SET status = 'running', updated_at = now()
      WHERE id = $1 AND status = 'queued' RETURNING id`,
    [batchId],
  );
  return rows.length > 0;
}

/** Idempotent: only completes when nothing is left in flight. */
export async function completeBatchIfDone(batchId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE batches SET status = 'completed', updated_at = now()
      WHERE id = $1 AND status IN ('queued','running')
        AND NOT EXISTS (SELECT 1 FROM urls WHERE batch_id = $1 AND status IN ('queued','running'))
      RETURNING id`,
    [batchId],
  );
  return rows.length > 0;
}

/** Cancels the batch and every URL that has not reached a terminal state. */
export async function cancelBatch(
  batchId: string,
): Promise<{ cancelled: boolean; cancelledUrls: { id: string; runCount: number }[] }> {
  return withTransaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      `UPDATE batches SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status IN ('queued','running') RETURNING id`,
      [batchId],
    );
    if (batch.rowCount === 0) return { cancelled: false, cancelledUrls: [] };

    const urls = await client.query<{ id: string; run_count: number }>(
      `UPDATE urls SET status = 'cancelled', updated_at = now()
        WHERE batch_id = $1 AND status IN ('queued','running')
        RETURNING id, run_count`,
      [batchId],
    );
    return {
      cancelled: true,
      cancelledUrls: urls.rows.map((r) => ({ id: r.id, runCount: r.run_count })),
    };
  });
}

/** Re-queues only failed/cancelled URLs; successful work is untouched. */
export async function retryFailedUrls(batchId: string): Promise<UrlCheck[]> {
  return withTransaction(async (client) => {
    const rows = await client.query<UrlRow>(
      `UPDATE urls
          SET status = 'queued', run_count = run_count + 1, attempts = 0,
              http_status = NULL, response_time_ms = NULL, title = NULL,
              final_url = NULL, error = NULL, updated_at = now()
        WHERE batch_id = $1 AND status IN ('failed','cancelled')
        RETURNING *`,
      [batchId],
    );
    if (rows.rowCount === 0) return [];

    await client.query(
      `UPDATE batches SET status = 'running', updated_at = now() WHERE id = $1`,
      [batchId],
    );
    return rows.rows.map(toUrl);
  });
}

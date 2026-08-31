import { z } from 'zod';

/** Single source of truth for every shape crossing the client <-> server boundary. */

export const BATCH_STATUSES = ['queued', 'running', 'completed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const URL_STATUSES = ['queued', 'running', 'success', 'failed', 'cancelled'] as const;
export type UrlStatus = (typeof URL_STATUSES)[number];

export const MAX_URLS_PER_BATCH = 500;

/** Batch list is keyset-paginated; the UI pulls pages as the user scrolls. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** Rows revealed per step in the single-batch URL table. */
export const URL_PAGE_SIZE = 50;

export interface UrlCheck {
  id: string;
  batchId: string;
  url: string;
  status: UrlStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  title: string | null;
  finalUrl: string | null;
  error: string | null;
  attempts: number;
  runCount: number;
  updatedAt: string;
}

export interface BatchCounts {
  total: number;
  pending: number;
  success: number;
  failed: number;
  cancelled: number;
}

export interface BatchSummary {
  id: string;
  name: string;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  counts: BatchCounts;
}

export interface BatchDetail extends BatchSummary {
  urls: UrlCheck[];
}

/**
 * One page of the batch list. `nextCursor` is opaque to the client: it is only ever
 * echoed back, never parsed, so the keyset encoding stays a server concern.
 */
export interface BatchListPage {
  batches: BatchSummary[];
  nextCursor: string | null;
}

export const batchListQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type BatchListQuery = z.infer<typeof batchListQuerySchema>;

export const createBatchSchema = z.object({
  name: z.string().trim().max(120).optional(),
  urls: z
    .array(z.string())
    .min(1, 'at least one URL is required')
    .max(MAX_URLS_PER_BATCH, `at most ${MAX_URLS_PER_BATCH} URLs per batch`),
});
export type CreateBatchInput = z.infer<typeof createBatchSchema>;

export interface CreateBatchResponse {
  batchId: string;
  /** Everything the client needs to track the batch without guessing routes. */
  batchUrl: string;
  streamUrl: string;
  batch: BatchDetail;
}

export interface ActionResponse {
  batch: BatchDetail;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

/** Events pushed over SSE. `snapshot` is always sent first on (re)connect. */
export type StreamEvent =
  | { type: 'snapshot'; batch: BatchDetail }
  | { type: 'url'; url: UrlCheck }
  | { type: 'batch'; batch: BatchSummary }
  | { type: 'batch-list'; page: BatchListPage };

export const TERMINAL_BATCH_STATUSES: BatchStatus[] = ['completed', 'cancelled'];

export function isBatchTerminal(status: BatchStatus): boolean {
  return TERMINAL_BATCH_STATUSES.includes(status);
}

export function progressPercent(counts: BatchCounts): number {
  if (counts.total === 0) return 0;
  return Math.round(((counts.total - counts.pending) / counts.total) * 100);
}

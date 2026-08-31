'use client';

import type {
  ActionResponse,
  BatchDetail,
  BatchListPage,
  CreateBatchResponse,
} from '@buhc/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function post<T>(path: string, body?: unknown, headers: HeadersInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    // Only claim a JSON body when there is one. Cancel and retry send none, and Fastify
    // rejects `content-type: application/json` with an empty body (FST_ERR_CTP_EMPTY_JSON_BODY)
    // before the route ever runs.
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A gateway or crash can answer with something that is not JSON; the status is still
  // the useful part of the message, so parsing must not swallow it.
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(json?.error ?? `request failed (${res.status})`);
  if (!json) throw new Error('malformed response from server');
  return json;
}

export function createBatch(
  urls: string[],
  name: string | undefined,
  idempotencyKey: string,
): Promise<CreateBatchResponse> {
  return post('/api/batches', { urls, name }, { 'idempotency-key': idempotencyKey });
}

export function cancelBatch(id: string): Promise<ActionResponse> {
  return post(`/api/batches/${id}/cancel`);
}

export function retryFailed(id: string): Promise<ActionResponse> {
  return post(`/api/batches/${id}/retry-failed`);
}

export async function getBatch(id: string): Promise<BatchDetail> {
  const res = await fetch(`${API_URL}/api/batches/${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load batch (${res.status})`);
  return res.json() as Promise<BatchDetail>;
}

/** Next page of the batch list. The cursor is opaque — echoed back, never parsed. */
export async function fetchBatchPage(cursor: string, limit: number): Promise<BatchListPage> {
  const params = new URLSearchParams({ cursor, limit: String(limit) });
  const res = await fetch(`${API_URL}/api/batches?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load more batches (${res.status})`);
  return res.json() as Promise<BatchListPage>;
}

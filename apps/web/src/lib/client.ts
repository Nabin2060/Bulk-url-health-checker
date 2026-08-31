'use client';

import type { ActionResponse, BatchDetail, CreateBatchResponse } from '@buhc/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function post<T>(path: string, body?: unknown, headers: HeadersInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
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

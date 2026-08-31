import { DEFAULT_PAGE_SIZE, type BatchDetail, type BatchListPage } from '@buhc/shared';

/** Server-side base URL (container network); the browser uses NEXT_PUBLIC_API_URL. */
const INTERNAL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/**
 * `no-store`: the 30s cache lives in Redis behind the API, so Next must not add a
 * second, uninvalidatable cache layer on top of it.
 */
export async function fetchBatches(limit = DEFAULT_PAGE_SIZE): Promise<BatchListPage> {
  const res = await fetch(`${INTERNAL}/api/batches?limit=${limit}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to load batches (${res.status})`);
  return res.json() as Promise<BatchListPage>;
}

export async function fetchBatch(id: string): Promise<BatchDetail | null> {
  const res = await fetch(`${INTERNAL}/api/batches/${id}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`failed to load batch (${res.status})`);
  return res.json() as Promise<BatchDetail>;
}

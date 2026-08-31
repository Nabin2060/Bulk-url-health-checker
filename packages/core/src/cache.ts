import type { BatchListPage } from '@buhc/shared';
import { config } from './config';
import { CACHE_KEY_BATCH_LIST, CACHE_KEY_BATCH_LIST_VERSION, redis } from './redis';

/**
 * The list is paginated, so each page is cached under its own key. Invalidation is a
 * version bump rather than a DEL of every page:
 *
 *  - one INCR invalidates every page at once, with no key scan;
 *  - it closes the cache-aside race. A reader that read the DB *before* an invalidation
 *    writes under the version it read, so its stale value lands on a key nobody will
 *    look up again. With a plain DEL, that late write would resurrect stale data and
 *    hold it for the full 30s TTL — user-visible staleness, which the brief rules out.
 *
 * Superseded keys are never read again and expire on their own TTL.
 */
async function version(): Promise<string> {
  return (await redis().get(CACHE_KEY_BATCH_LIST_VERSION)) ?? '0';
}

function pageKey(v: string, cursor: string | undefined, limit: number): string {
  return `${CACHE_KEY_BATCH_LIST}:v${v}:${limit}:${cursor ?? 'head'}`;
}

/** Returns the cached page plus the version it was read under, for a safe write-back. */
export async function readBatchListCache(
  cursor: string | undefined,
  limit: number,
): Promise<{ page: BatchListPage | null; version: string }> {
  const v = await version();
  const raw = await redis().get(pageKey(v, cursor, limit));
  return { page: raw ? (JSON.parse(raw) as BatchListPage) : null, version: v };
}

export async function writeBatchListCache(
  cursor: string | undefined,
  limit: number,
  v: string,
  page: BatchListPage,
): Promise<void> {
  await redis().set(
    pageKey(v, cursor, limit),
    JSON.stringify(page),
    'EX',
    config.batchListCacheTtlSeconds,
  );
}

export async function invalidateBatchListCache(): Promise<void> {
  await redis().incr(CACHE_KEY_BATCH_LIST_VERSION);
}

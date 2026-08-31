import type { BatchSummary } from '@buhc/shared';
import { config } from './config';
import { CACHE_KEY_BATCH_LIST, redis } from './redis';

export async function readBatchListCache(): Promise<BatchSummary[] | null> {
  const raw = await redis().get(CACHE_KEY_BATCH_LIST);
  return raw ? (JSON.parse(raw) as BatchSummary[]) : null;
}

export async function writeBatchListCache(batches: BatchSummary[]): Promise<void> {
  await redis().set(
    CACHE_KEY_BATCH_LIST,
    JSON.stringify(batches),
    'EX',
    config.batchListCacheTtlSeconds,
  );
}

export async function invalidateBatchListCache(): Promise<void> {
  await redis().del(CACHE_KEY_BATCH_LIST);
}

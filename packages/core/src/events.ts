import type { BatchSummary, StreamEvent, UrlCheck } from '@buhc/shared';
import { CACHE_KEY_BATCH_LIST, CHANNEL_CANCEL, CHANNEL_EVENTS, redis } from './redis';

/**
 * Every state change fans out through Redis pub/sub so any API instance can push it
 * to its own SSE clients, and drops the batch-list cache so it can never show a
 * state the user has already seen change.
 */
export async function publishEvent(event: StreamEvent): Promise<void> {
  const r = redis();
  if (event.type === 'batch' || event.type === 'url') {
    await r.del(CACHE_KEY_BATCH_LIST);
  }
  await r.publish(CHANNEL_EVENTS, JSON.stringify(event));
}

export async function publishUrl(url: UrlCheck): Promise<void> {
  await publishEvent({ type: 'url', url });
}

export async function publishBatch(batch: BatchSummary): Promise<void> {
  await publishEvent({ type: 'batch', batch });
}

/** Tells worker processes to abort in-flight checks for this batch. */
export async function publishCancel(batchId: string): Promise<void> {
  await redis().publish(CHANNEL_CANCEL, batchId);
}

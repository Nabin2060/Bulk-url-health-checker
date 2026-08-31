import { Queue } from 'bullmq';
import type { UrlCheck } from '@buhc/shared';
import { MAX_ATTEMPTS, config } from './config';
import { createRedis } from './redis';

export const QUEUE_NAME = 'url-checks';

export interface CheckJobData {
  urlId: string;
  batchId: string;
  url: string;
  runCount: number;
}

let queueInstance: Queue<CheckJobData> | null = null;

export function checkQueue(): Queue<CheckJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<CheckJobData>(QUEUE_NAME, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return queueInstance;
}

/** Redis-side cap, so N worker processes still total CONCURRENCY jobs in flight. */
export async function applyGlobalConcurrency(): Promise<void> {
  await checkQueue().setGlobalConcurrency(config.concurrency);
}

/** jobId is derived from (urlId, runCount) so re-enqueueing the same work is a no-op. */
export function jobIdFor(urlId: string, runCount: number): string {
  return `${urlId}-${runCount}`;
}

export async function enqueueChecks(batchId: string, urls: UrlCheck[]): Promise<void> {
  if (urls.length === 0) return;
  await checkQueue().addBulk(
    urls.map((u) => ({
      name: 'check',
      data: { urlId: u.id, batchId, url: u.url, runCount: u.runCount },
      opts: { jobId: jobIdFor(u.id, u.runCount) },
    })),
  );
}

/** Best-effort removal of jobs that have not started yet. In-flight jobs are aborted via pub/sub. */
export async function removeJobs(jobIds: string[]): Promise<void> {
  const queue = checkQueue();
  await Promise.all(
    jobIds.map(async (id) => {
      try {
        await queue.remove(id);
      } catch {
        /* active or already gone */
      }
    }),
  );
}
